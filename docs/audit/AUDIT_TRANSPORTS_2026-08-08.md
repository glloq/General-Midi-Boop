# Audit A1 — Transports & I/O appareils (2026-08-08)

Audit adversarial (3 relecteurs parallèles) de la couche transport/I/O :
BLE, RTP-MIDI/réseau, Serial + intégration `DeviceManager`. Chaque finding a été
vérifié par relecture ; les correctifs appliqués sont testés.

**Statut global :** tous les findings de correction claire (non-sécurité) sont
**corrigés** (15 items ; 9 avec tests dédiés, 6 couverts par relecture + suite
complète). Restent uniquement les items **sécurité RTP-MIDI**, volontairement
**différés** (décision « LAN de confiance » : on documente, on ne change pas le
comportement).

---

## ✅ Corrigés + testés

### BLE

- **BLE#1 (MAJEUR) — SysEx interrompu par un status byte** `BluetoothManager._handleIncomingMidi`.
  Un appareil qui abandonne un SysEx avec un nouveau message (au lieu de `0xF7`)
  faisait manger le status comme timestamp → note perdue + SysEx bloqué ouvert.
  Corrigé : le consommateur SysEx distingue timestamp de framing vs status
  d'abandon (drapeau `consumedData`). Tests : `tests/ble-midi-decode.test.js`.
- **BLE#2 (MAJEUR) — fuite GATT/listener sur échec partiel de connexion**
  `NobleBleAdapter.connect()`. `_connections` n'était peuplé qu'au succès complet,
  donc un throw après `device.connect()` laissait un lien BlueZ à moitié ouvert
  (zombie) + un listener `valuechanged` fuité, sans chemin de nettoyage. Corrigé :
  `try/catch` autour des étapes post-lien → teardown best-effort (retrait listener,
  `stopNotifications`, `device.disconnect`) puis rethrow. Tests :
  `tests/noble-ble-connect-teardown.test.js`.
- **BLE#3 (MAJEUR, conformité) — encodeur séparait le timestamp du `0xF7`**
  `BluetoothManager.encodeBleMidiPackets`. Pour certaines longueurs de SysEx
  (données brutes 18/37/56…) le chunking à plat plaçait `0xF7` en tête de paquet,
  laissant son timestamp dans le paquet précédent. Corrigé : les `[ts,F0]`/`[ts,F7]`
  sont des tokens atomiques 2 octets, jamais scindés. Tests :
  `tests/ble-midi-encode.test.js` (adjacence + MTU + round-trip encode→decode).
- **BLE#4 (MAJEUR) — garde `startScan` racy** `BluetoothManager.startScan`.
  Check-then-act à travers un `await` : deux `ble_scan_start` simultanés passaient
  la garde et racaient `devices.clear()`. Corrigé : `scanning=true` posé
  **avant** l'`await this._initPromise` (dans le `try`). Couvert par relecture +
  suite complète.
- **BLE#6 (MINEUR) — `_scheduleReconnect` écrasait `entry.timer` sans clear**
  → timer orphelin = reconnexion en trop. Corrigé : `clearTimeout` avant de
  ré-armer. Couvert par relecture.

### RTP-MIDI / réseau

- **RTP L1 (FAIBLE) — System Common ne réinitialisait pas le running status**
  `RtpMidiSession.parseMidiPayload` (seul `0xF0` resettait). `F3 05` puis data →
  commande fabriquée. Corrigé : `0xF1–0xF7` remet `runningStatus=0`. Tests :
  `tests/rtp-midi-parser-fixes.test.js`.
- **RTP M4 (MOYEN) — bit P (running status inter-paquets) ignoré**
  `RtpMidiSession.parseMidiPayload` → 1ʳᵉ commande d'un paquet `P=1` perdue.
  Corrigé : lecture du bit P + persistance de `_rtpRunningStatus` entre paquets.
  Tests : `tests/rtp-midi-parser-fixes.test.js`.
- **RTP L7 (FAIBLE) — `parseRtpPacket` throw sur extension malformée**
  (`readUInt16BE` hors borne). Corrigé : borne + `return null`. Tests :
  `tests/rtp-midi-parser-fixes.test.js`.
- **RTP M2 (MOYEN) — `_ensureSockets()` sans garde in-flight** `NetworkManager`
  → deux connexions concurrentes racaient le bind (fuite de socket / port 5004 mal
  bindé). Corrigé : promesse d'init partagée (`_ensureSocketsPromise`), remise à
  `null` en `finally` pour permettre un re-bind après `shutdown()`. Couvert par
  relecture + suite complète.
- **RTP L3 (FAIBLE) — timer connect-timeout jamais `clearTimeout`/`unref`**
  `NetworkManager.connect` → maintenait la boucle d'events 10 s et rejetait
  `connectTimeout` après règlement de la course (rejet non géré). Corrigé :
  capture du handle, `unref()`, `clearTimeout` en `finally`. Couvert par relecture.
- **RTP L5 (FAIBLE) — `network:disconnected` émis 2×** `NetworkManager.disconnect`
  (le handler `disconnected` de la session émet déjà + `disconnect()` ré-émettait).
  Corrigé : le handler de session est l'unique émetteur ; `disconnect()` n'émet que
  s'il n'y a pas de session vivante. Payload unifié `{ ip, device_id }`. Couvert
  par relecture. *(Actuellement latent : aucun consommateur backend de l'event.)*
- **RTP L6 (FAIBLE) — `shutdown()` n'itérait pas les `rtpSessions` pendantes**
  → sessions responder mi-handshake (jamais entrées dans `connectedDevices`)
  gardaient leur watchdog actif. Corrigé : fermeture de toute session restante
  après la boucle `connectedDevices`. Couvert par relecture.

### Serial / USB / intégration DeviceManager

- **Serial#1 (MOYEN-HAUT) — `device_disconnected` jamais émis sur l'EventBus**
  `DeviceManager` (callback `update`). Corrigé : diff avant/après de la map
  d'appareils → émission par appareil disparu (rend enfin actif le reset
  note-gate-sur-déconnexion). Couvert par relecture + suite.
- **Serial#2 (MOYEN) — vel-0 note-on non normalisé en note-off (serial/USB)**
  Seul BLE/réseau passait par `handleRawMidi` (qui normalise). Serial/USB
  livraient `noteon` vel-0 → latches anti-note-bloquée et rate-limiter le
  traitaient comme un note-on → note potentiellement bloquée. Corrigé : normalisé
  au point d'entrée commun `DeviceManager.handleMidiMessage`. Tests :
  `tests/devicemanager-velocity0-noteoff.test.js`.
- **Serial#3 (FAIBLE) — buffer channel-voice partiel non vidé au démarrage SysEx**
  `SerialMidiManager._parseByte` → note fantôme sur flux malformé. Corrigé : vidage
  de `state.buffer`/`expectedLength` au `0xF0`. Tests :
  `tests/serial-sysex-partial-flush.test.js`.

---

## 🔴 Différés — DÉCISION « LAN de confiance » (modèle de menace RTP-MIDI)

Le transport RTP-MIDI écoute sur le LAN et **fait confiance à l'IP source** —
`remoteSsrc` est assigné mais **jamais validé**, aucun token vérifié.

- **RTP M1 (MOYEN) — paquets de contrôle forgés** ferment/mutent une session
  (`END`/`IN` forgés avec l'IP d'un pair) → DoS de session / injection MIDI.
- **RTP M3 (MOYEN, interop) — port UDP de l'émetteur ignoré** (réponses toujours
  vers 5004/5005) → pairs initiant depuis un autre port jamais joignables.
- **RTP M5 (FAIBLE-MOYEN) — invitation data-port malformée** → « connecté »
  fantôme.
- **RTP L2/L4 — pas de retransmission d'invitation ; sessions responder non
  limitées.**

**Décision (2026-08-08) : « LAN de confiance » — différé.** Valider SSRC/token et
rejeter les ports non-5004 changerait le comportement avec des pairs légitimes.
Le déploiement cible (Raspberry Pi offline sur LAN de confiance) ne justifie pas
ce durcissement pour l'instant. Ces items sont **documentés mais non corrigés** ;
à ré-arbitrer si le box est un jour exposé à un réseau non-fiable.

---

## Notes & confirmations

- **Journal de récupération RFC 6295 (T4.2) confirmé absent** : perte de paquet →
  drop silencieux (note bloquée possible) ; hors-ordre → appliqué tel quel. Le
  parser borne la section MIDI par LEN → **pas de corruption d'état** sur perte.
- **Note « NobleBleAdapter non câblé en DI » (T5.2) obsolète/fausse** : c'est le
  port de PRODUCTION (`BluetoothManager` délègue à `this._port` = `NobleBleAdapter`
  par défaut). Rien n'est mort. La logique de teardown BLE#2 est désormais testée
  via des fakes injectés (`tests/noble-ble-connect-teardown.test.js`) ; seule la
  **QA sur matériel réel** (lien BlueZ physique) reste non exécutée.
- **Parsers crash-hardened** : fuzz 50k paquets RTP → 0 crash/OOB.
- Vérifié CORRECT (extraits) : décodage BLE canal/running-status/realtime/SysEx
  multi-paquet ; codec AppleMIDI (IN/OK/NO/BY/CK) ; parsing serial realtime/running
  /SysEx/backpressure ; auto-identity debounce/retry ; dégradation gracieuse des
  transports optionnels (try/catch + `?.`).
