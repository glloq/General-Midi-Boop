# Audit A1 — Transports & I/O appareils (2026-08-08)

Audit adversarial (3 relecteurs parallèles) de la couche transport/I/O :
BLE, RTP-MIDI/réseau, Serial + intégration `DeviceManager`. Chaque finding a été
vérifié par relecture ; les correctifs appliqués sont testés.

**Statut global :** 2 bugs de correction corrigés+testés (BLE#1, Serial#1). Le
reste est listé ci-dessous avec sévérité et recommandation ; plusieurs demandent
une **décision** (modèle de menace RTP) ou une **QA matérielle**.

---

## ✅ Corrigés + testés

- **BLE#1 (MAJEUR) — SysEx interrompu par un status byte** `BluetoothManager._handleIncomingMidi`.
  Un appareil qui abandonne un SysEx avec un nouveau message (au lieu de `0xF7`)
  faisait manger le status comme timestamp → note perdue + SysEx bloqué ouvert.
  Corrigé : le consommateur SysEx distingue timestamp de framing vs status
  d'abandon (drapeau `consumedData`). Tests : `tests/ble-midi-decode.test.js`
  (8 cas : baseline + abandon inter/intra-paquet).
- **Serial#1 (MOYEN-HAUT) — `device_disconnected` jamais émis sur l'EventBus**
  `DeviceManager` (callback `update`). Le chemin de retrait ne rafraîchissait que
  l'UI → l'event n'atteignait jamais l'EventBus, rendant **code mort** le reset
  du note-gate du routeur (fix de la session), l'invalidation du cache d'horloge,
  et le pont WS. Corrigé : diff avant/après de la map d'appareils → émission par
  appareil disparu. (Rend enfin actif le fix note-gate-sur-déconnexion.)

---

## 🟠 Ouverts — correction claire, à faire (cheap, bas risque)

- **BLE#4 (MAJEUR) — garde `startScan` racy** `BluetoothManager:249-255`.
  Check-then-act à travers un `await` : deux `ble_scan_start` simultanés passent
  la garde, `devices.clear()` concurrents corrompent la map. → poser
  `scanning=true` **avant** l'await.
- **RTP L1 (FAIBLE) — System Common ne réinitialise pas le running status**
  `RtpMidiSession:425-428` (seul `0xF0` reset). `F3 05` puis data → commande
  fabriquée. → `0xF1–0xF7` doit remettre `runningStatus=0`.
- **RTP L7 (FAIBLE) — `parseRtpPacket` throw sur extension malformée**
  `RtpMidiSession:346-349` (`readUInt16BE` hors borne). Contenu (try/catch en
  amont) → log-spam seulement. → borne + `return null`.
- **BLE#6 (MINEUR) — `_scheduleReconnect` écrase `entry.timer` sans clear**
  `BluetoothManager:169` → timer orphelin = reconnexion en trop. → `clearTimeout`.
- **RTP L3/L5/L6 (FAIBLE) — cycles de vie** : timer connect-timeout jamais
  `clearTimeout`/`unref` (`NetworkManager:521-534`) ; `network:disconnected` émis
  2× (`:506-513` + `:660-664`) ; `shutdown()` n'itère pas les `rtpSessions`
  pendantes (`:1008-1034`).
- **Serial#3 (FAIBLE) — buffer channel-voice partiel non vidé au démarrage SysEx**
  `SerialMidiManager:433-438` → note fantôme sur flux malformé.

## 🟠 Ouverts — correction réelle mais plus large (à planifier)

- **Serial#2 (MOYEN) — vel-0 note-on non normalisé en note-off (serial/USB/réseau)**
  Seul BLE passe par `handleRawMidi` (qui normalise). Serial/USB/réseau livrent
  `noteon` vel-0 → les latches anti-note-bloquée du routeur (`_clampToCapabilities`,
  `_getStableCompensation`) et le rate-limiter le traitent comme un note-on → note
  potentiellement bloquée. → normaliser à un point d'entrée commun.
- **RTP M2 (MOYEN) — `_ensureSockets()` sans garde in-flight** `NetworkManager:739-770`
  → deux connexions concurrentes racent le bind (fuite de socket / port 5004 mal
  bindé). → verrou/promesse d'init partagée.
- **RTP M4 (MOYEN) — bit P (running status inter-paquets) ignoré** `RtpMidiSession:365-443`
  → 1ʳᵉ commande d'un paquet `P=1` silencieusement perdue (perte MIDI, dépend du
  pair). Non couvert par T4.2.
- **BLE#2 (MAJEUR, matériel) — fuite GATT/listener sur échec partiel de connexion**
  `NobleBleAdapter.connect():238-247` (pas de try/catch → lien BlueZ à moitié
  ouvert non libéré ; zombie possible). QA matériel requise pour valider.
- **BLE#3 (MAJEUR, conformité) — encodeur sépare le timestamp du `0xF7`**
  `BluetoothManager:614-629` pour certaines longueurs (len brute 18/37/56…). Impact
  dépend de la tolérance du récepteur. → garder `[ts,F7]` dans le même paquet.

## 🔴 Ouverts — DÉCISION requise (modèle de menace RTP-MIDI)

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

→ Ces items exigent de décider le **niveau de confiance réseau** (LAN de
confiance vs durci). Valider SSRC/token et rejeter les ports non-5004 change le
comportement avec des pairs légitimes → à arbitrer avant correctif.

---

## Notes & confirmations

- **Journal de récupération RFC 6295 (T4.2) confirmé absent** : perte de paquet →
  drop silencieux (note bloquée possible) ; hors-ordre → appliqué tel quel. Le
  parser borne la section MIDI par LEN → **pas de corruption d'état** sur perte.
- **Note « NobleBleAdapter non câblé en DI » (T5.2) obsolète/fausse** : c'est le
  port de PRODUCTION (`BluetoothManager` délègue à `this._port` = `NobleBleAdapter`
  par défaut). Rien n'est mort. Le seul manque : la suite de contrat ne teste que
  `InMemoryBleAdapter` → les chemins matériels (dont BLE#2) sont non exercés.
- **Parsers crash-hardened** : fuzz 50k paquets RTP → 0 crash/OOB.
- Vérifié CORRECT (extraits) : décodage BLE canal/running-status/realtime/SysEx
  multi-paquet ; codec AppleMIDI (IN/OK/NO/BY/CK) ; parsing serial realtime/running
  /SysEx/backpressure ; auto-identity debounce/retry ; dégradation gracieuse des
  transports optionnels (try/catch + `?.`).
