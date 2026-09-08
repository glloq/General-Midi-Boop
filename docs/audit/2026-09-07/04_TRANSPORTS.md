# 04 — Transports : USB, BLE, UART, RTP-MIDI (lot L04)

**Date :** 2026-09-07 · **Base :** `00_BASELINE.md` (commit `8dc170e`)
**Périmètre :** sections **K** (USB), **L** (BLE), **M** (UART/GPIO),
**N01/N02** (RTP-MIDI / AppleMIDI), **G04** (hot-plug pendant la lecture).
**Findings réservés :** F-46 → F-53 (8 utilisés).

---

## 0. Le résultat en une phrase

L'audit du 2026-08-22 classait ces quatre sections **« HW REQUIRED »** en bloc.
C'était faux pour l'essentiel : **trois modules majeurs sont du JavaScript pur
derrière une façade matérielle**, et un faux énumérateur plus une socket UDP
locale suffisent à les exercer. Ils passent de **0,25 % / 17,3 % / 3,9 %** de
couverture à **65,8 % / 82,7 % / 54,5 %**, et cette mise sous test a fait
tomber **six défauts réels dont un P1** — un décodeur BLE qui perd un message
sur seize et injecte un faux message temps réel à sa place.

---

## 1. Synthèse

| Section | Sujet | État | Niveau | Findings |
|---|---|---|---|---|
| **K.1** | Énumération / filtre / ouverture des ports USB (`DeviceDiscovery`) | **PASS** | 4 | F-46 |
| **K.2** | Identité d'un device (deux ports homonymes) | **FAIL** | 4 | **F-46** |
| **K.3** | Ouverture réelle d'un port ALSA, latence, duplex, saturation | **HW REQUIRED** | 0 | — |
| **G04.1** | Hot-plug : apparition / disparition / renommage / port fantôme | **PASS** | 4 | F-48 (obs.) |
| **G04.2** | Débranchement **pendant la lecture** : statut de send, `device_disconnected` | **PASS** | 4 | — |
| **G04.3** | Notes tenues à la déconnexion / reconnexion (notes orphelines) | **FAIL** | 4 | **F-47** |
| **G04.4** | Fuite d'état / de handles après 50 cycles | **PASS** | 4 | — |
| **L.1** | Décodage des trames BLE-MIDI entrantes (horodatage, multi-messages, running status) | **FAIL → corrigé** | 4 | **F-48** |
| **L.2** | Machine à états : refus, expiration 15 s, coupure en plein flux | **PASS** | 4 | F-53 |
| **L.3** | Réassemblage SysEx à travers une coupure | **FAIL → corrigé** | 4 | **F-53** |
| **L.4** | Back-off 2/4/8/16/30 s, épuisement, fuite de timers sur 50 cycles | **PARTIAL** | 4 | **F-53** |
| **L.5** | Radio, appairage réel, portée, gigue | **HW REQUIRED** | 0 | — |
| **M.1** | Cycle de vie du port série (ouverture, erreurs, fermeture, événements) | **PASS** | 4 | F-52 |
| **M.2** | Activation / désactivation à chaud | **FAIL → corrigé** | 4 | **F-52** |
| **M.3** | Lecture du flux (chunks, débit 31 250 baud, débordement SysEx) | **PASS** | 4 | — |
| **M.4** | File d'écriture bornée + priorités (note-off / CC 120-123) | **PASS** | 4 | — |
| **M.5** | Hot-plug série (retrait, réapparition d'un port configuré) | **PASS** | 4 | — |
| **M.6** | Cadrage réel 31 250 baud, duplex, corruption d'octets, multi-UART | **HW REQUIRED** | 0 | — |
| **N01.1** | Sockets AppleMIDI partagées (P / P+1), repli éphémère, arrêt propre | **PASS** | 4 | — |
| **N01.2** | Poignée de main IN/OK sur les deux ports (rôle initiateur) | **PASS** | 4 | — |
| **N01.3** | Session entrante (rôle répondeur) | **FAIL → corrigé** | 4 | **F-50** |
| **N01.4** | Cycle connexion / reconnexion / déconnexion | **FAIL → corrigé** | 4 | **F-49** |
| **N01.5** | Flux RTP-MIDI : running status, bit P, messages système, trames malformées | **PASS** | 4 | — |
| **N02.1** | Perte / duplication / réordonnancement de paquets | **EXPERIMENTAL** (assumé) | 4 | **F-51** |
| **N02.2** | Honnêteté de l'auto-déclaration `degraded` | **PARTIAL** — vraie mais **périmée** | 4 | **F-51** |
| **N02.3** | Interopérabilité macOS / iOS / rtpmidid réelle | **HW REQUIRED** | 0 | — |

**Niveaux** : 0 = non testé · 3 = revue de code · 4 = test automatisé
reproductible · 5 = validé sur matériel réel. **Aucune section de ce lot
n'atteint le niveau 5** : c'est le rôle de L15.

**Bilan findings : 1 P1, 5 P2, 2 P3. Six sont corrigés dans ce lot** (chacun
avec un test rouge → vert) ; deux restent ouverts par décision de conception
(F-46, F-47) et un est une correction de documentation (F-51).

---

## 2. Méthode

### 2.1 Ce qui rend ces modules testables sans matériel

| Module | Façade matérielle | Point d'injection utilisé |
|---|---|---|
| `DeviceDiscovery` | `easymidi.getInputs()/getOutputs()` | 3ᵉ argument du constructeur — **prévu pour ça** |
| `DeviceManager` | `new easymidi.Output(name)` | seul point non injectable : remplacé par un port espion, tout le reste est le code de production |
| `NetworkManager` | UDP | **rien à injecter** : un pair AppleMIDI de 80 lignes en `dgram` sur `127.0.0.1` |
| `SerialMidiManager` | `import('serialport')` | `this.SerialPort` (chargé dynamiquement) + `stream.Readable` pour le flux |
| `BluetoothManager` | port BLE | `InMemoryBleAdapter`, **fourni par le projet** |

### 2.2 Environnement

Conforme à `00_BASELINE.md` : Node v22.22.2, pas d'ALSA (`easymidi` absent),
pas de D-Bus, pas de port série, pas de pair réseau. **Vérifié pour ce lot :**
`fs.existsSync('/proc/asound/cards') === false` — c'est donc la branche
`easymidi` de `DeviceDiscovery._detectCurrentPorts()` qui est exercée (la
branche `/proc/asound`, spécifique à ALSA, reste HW REQUIRED).

Aucun `npm install`, aucun fichier partagé modifié, `git diff config.json` vide.

### 2.3 Fichiers produits

| Fichier | Tests | Ce qu'il couvre |
|---|---|---|
| `tests/transports/l04-device-discovery.test.js` | 16 | §K, §G04 — énumérateur bouchon |
| `tests/transports/l04-hotplug-during-playback.test.js` | 7 | §G04 — débranchement en lecture |
| `tests/transports/l04-network-manager.test.js` | 29 | §N01, §N02 — pair AppleMIDI local |
| `tests/transports/l04-serial-port-management.test.js` | 23 | §M — gestion de port + flux |
| `tests/transports/l04-ble-connection-state.test.js` | 17 | §L — machine à états |
| **Total** | **92** | |

Reproduction (un seul run, ~2 s) :

```bash
node --experimental-vm-modules node_modules/jest/bin/jest.js tests/transports/
```

---

## 3. §K + §G04 — USB et hot-plug

### 3.1 Ce qui marche (PASS, niveau 4)

`scanAndReopen()` ferme les ports ouverts (`removeAllListeners()` **avant**
`close()`, ordre vérifié), vide les Map, attend la libération, ré-énumère,
filtre les ports système (`Midi Through`, `IAC Driver`, `loopMIDI`, `FLUID
Synth`…) et ouvre le reste. Un `close()` qui lève n'interrompt pas le scan ; un
port fantôme dont l'ouverture échoue est ignoré et **les suivants sont quand
même ouverts** — pas de port orphelin, pas d'entrée fantôme dans la Map.

Les noms sont transmis **tels quels** : Unicode (`日本語シンセ`), emoji, espaces
en tête/queue, 512 caractères — aucune normalisation, aucune troncature.

Le hot-plug (branche `easymidi`) traite correctement apparition, disparition et
renommage (= retrait + ajout). **50 cycles connexion/déconnexion** ramènent
`knownInputs`, `knownOutputs`, `inputs` et `outputs` à zéro : aucune fuite.
`startHotPlugMonitoring()` est ré-entrant (un seul timer armé) et 20 cycles
start/stop ne laissent aucun timer résiduel (`jest.getTimerCount()`).

La boucle de surveillance est robuste : si l'énumération lève (cas réel :
épuisement des clients séquenceur ALSA), le compteur d'échecs monte et la
surveillance **s'auto-arrête au 5ᵉ échec consécutif** ; un tick réussi le
remet à zéro.

### 3.2 F-46 — deux ports de même nom : le second est injoignable

L'identité d'un device est **son nom**, partout : `inputs`/`outputs` sont des
`Map` clefées par le nom, `devices` aussi, et les routes comme les réglages
d'instrument référencent ce nom. Deux instruments identiques branchés
simultanément (deux Arturia KeyStep, deux interfaces USB-MIDI du même modèle)
apparaissent sous le même libellé.

**Preuve** (`l04-device-discovery.test.js`, « F-46 ») : l'énumérateur renvoie
`['Arturia KeyStep', 'Arturia KeyStep']`, `addInput` est bien appelé **deux
fois**, et la Map finale ne contient **qu'une seule entrée**. Le second port
physique est ouvert par personne et n'est adressable par rien.

Ce n'est pas un bug local mais un **choix d'identité** : `usb_serial_number`
existe déjà (`DeviceDiscovery.getUsbSerialNumbers()`) et sert à retrouver les
réglages d'un instrument rebranché, mais il n'entre pas dans la clef. Le
corriger touche `DeviceManager`, le routage, la persistance et l'UI — hors
périmètre d'un correctif « petit et local ». **Laissé ouvert, documenté.**

### 3.3 F-47 — débranchement pendant la lecture : les notes restent orphelines

Scénario de scène, jamais testé jusqu'ici : trois notes sont envoyées et
tenues, puis le câble est arraché au milieu du morceau.

**Ce qui marche.** Le port est fermé exactement une fois, retiré des Map,
`device_disconnected` est émis **exactement une fois** (c'est le contrat dont
dépend la remise à zéro du note-gate de `MidiRouter`), et les envois suivants
renvoient `SEND_STATUS.DISCONNECTED` — donc `PlaybackScheduler` peut appliquer
sa politique `skip`/`pause`/`mute`. 50 cycles débranchement/rebranchement ne
laissent aucun handle ni aucun état de reconnaissance résiduel.

**Ce qui ne marche pas.** Entre le dernier `noteon` et la fermeture du port,
**rien n'est envoyé** : aucun note-off, aucun CC 120 (All Sound Off), aucun
CC 123 (All Notes Off). Et **au rebranchement, rien non plus** : le port est
rouvert, `device_connected` est émis, une sonde d'identité part — mais aucun
message de silence. Un synthé auto-alimenté (le cas normal : seul le câble
MIDI/USB est débranché, pas l'alimentation) **continue de sonner ses notes
tenues jusqu'à ce qu'un humain déclenche un panic**.

**Preuve** : `l04-hotplug-during-playback.test.js`, tests « F-47 » et « F-47
(suite) » — `out.sent` ne contient que les note-on avant la coupure, et le port
rouvert reçoit `[]`.

**Non corrigé** : envoyer un All-Notes-Off à un port qui vient de réapparaître
est une décision musicale (elle coupe aussi ce que l'instrument jouait de son
propre chef), et le point d'insertion est `DeviceManager._onDevicePortAdded()`
— hors du périmètre `src/transports/**` alloué à ce lot. **Recommandation
détaillée au §8.1.**

### 3.4 F-48 (volet observabilité) — deux sources de bruit

1. **Port fantôme non borné.** Un port qui apparaît à l'énumération mais refuse
   de s'ouvrir n'est **pas** mémorisé (comportement voulu : il sera retenté).
   Conséquence non voulue : une tentative **et un log d'erreur toutes les 5 s,
   indéfiniment**. Trois ticks ⇒ trois tentatives (preuve dans le test).
2. **Déluge de warns.** Après un débranchement en lecture, **chaque** message
   destiné au device disparu produit un `logger.warn('Output device not
   found')`. Mesuré : **200 messages ⇒ 200 lignes**. `PlaybackScheduler`
   déduplique sa *notification* (`_failedDevices`) mais pas ce log. Sur une
   lecture dense à 500 msg/s, c'est le journal qui devient inutilisable au
   moment précis où on en a besoin.

---

## 4. §M — UART / GPIO

### 4.1 Ce qui marche (PASS, niveau 4)

Ouverture : `baudRate: 31250, dataBits: 8, parity: 'none', stopBits: 1,
autoOpen: false` — vérifié sur les options réellement passées au constructeur.
Ré-ouverture refusée, périphérique absent → message qui pointe `config.txt`,
`EACCES` → consigne `usermod -aG dialout`, `EBUSY` → « port occupé ». Fermeture
explicite et fermeture pilotée par le driver (câble arraché) émettent
`serial:disconnected` ; une erreur du driver émet `serial:error` **sans**
fermer le port.

**Lecture du flux** (injection par `stream.Readable`, comme le pilote) : un
message découpé en trois chunks d'un octet est reconstitué ; la source remontée
à `DeviceManager` est le **chemin** du port et non son nom convivial (la
régression « audit P1 » est donc verrouillée) ; un port ouvert en `out` n'a
aucun écouteur `data` ; des octets arrivant après la fermeture sont ignorés
sans exception.

**Débit 31 250 baud simulé par la charge** : 31 250 bauds 8N1 = 3 125 octets/s
= 1 041 messages de 3 octets par seconde. Une seconde entière de trafic saturé
est parsée **en moins de 250 ms** (mesuré ≈ 6 ms) — le parser a deux ordres de
grandeur de marge.

**Débordement du tampon SysEx** : 70 000 octets de SysEx (> `MAX_SYSEX_BUFFER_SIZE`
= 65 536) sont abandonnés avec un avertissement, l'état du parser est remis à
zéro et **le port reste utilisable** (le message suivant est parsé).

**File d'écriture** : sous contre-pression permanente (`write()` renvoie
toujours `false`), 3 000 messages saturent la file, qui reste plafonnée à
**1 024**, avec des `droppedWrites` comptés — et les deux messages prioritaires
(All Notes Off, note-off) sont **en tête de file et jamais évincés**. Une
écriture qui lève émet `write:error` **sans verrouiller la file**
(`portInfo.writing` revient à `false`).

**Hot-plug série** : le retrait ferme le port et le retire des deux ensembles ;
la réapparition ne rouvre **que** les ports explicitement configurés (un
`/dev/ttyUSB0` étranger n'est jamais pris d'office).

### 4.2 F-52 — deux défauts de cycle de vie (corrigés)

**(a) `setEnabled(false)` puis `setEnabled(true)` laissait le MIDI série mort.**
`setEnabled(false)` appelle `shutdown()` : tous les ports fermés, surveillance
hot-plug arrêtée. `setEnabled(true)` ne testait que `!this.SerialPort` — or la
bibliothèque est toujours chargée, donc **la branche de réinitialisation était
sautée et la fonction ne faisait rien**. Aucun port rouvert, aucune
surveillance relancée : le MIDI série restait éteint jusqu'au redémarrage du
serveur, pendant que `getStatus()` annonçait `enabled: true, available: true`.
C'est une capacité morte au sens du critère de sortie n°1 du plan.

**(b) Le garde-fou d'ouverture de 10 s n'était jamais annulé.**
`openPort()` faisait `Promise.race([openPromise, timeoutPromise])` sans
`clearTimeout`. Après **chaque** ouverture réussie, un timer de
`PORT_OPEN_TIMEOUT_MS` restait armé et **retenait la boucle d'événements
10 secondes** — visible à l'arrêt du serveur (SIGTERM qui traîne) et sur chaque
ré-ouverture hot-plug. C'est exactement la classe de bug déjà corrigée côté
réseau (« audit A1 RTP-L3 ») et jamais balayée ici.

**Preuve rouge → vert** : `l04-serial-port-management.test.js`, tests « F-52 »
et « F-52 (suite) ». Avant correctif : `jest.getTimerCount()` = 1 au lieu de 0,
et `openPorts.has(path)` = `false` après réactivation.

---

## 5. §N01 / §N02 — RTP-MIDI / AppleMIDI

Tout ce qui suit est mesuré contre un **pair AppleMIDI local** (deux sockets
`dgram` sur `127.0.0.1`), écrit indépendamment du code de production, avec un
encodeur RTP-MIDI de test lui aussi indépendant.

### 5.1 Ce qui marche (PASS, niveau 4)

**Sockets partagées.** Le port de contrôle `P` et le port de données `P+1` sont
liés une fois pour toutes les sessions. Si `P` est occupé, le repli sur une
socket éphémère fonctionne (émission conservée, réception perdue sur ce canal)
avec l'avertissement attendu. Trois `_ensureSockets()` concurrents ne lient
qu'une paire. `shutdown()` ferme réellement : le port redevient liable.

**Poignée de main (initiateur).** `connect()` envoie `IN` sur le port de
contrôle du pair avec `protocolVersion = 2` et le nom `GeneralMidiBoop` ; sur
`OK` il envoie `IN` sur le **port de données** ; sur le second `OK` la session
est établie, `network:connected` est émis une fois et `getConnectedDevices()`
n'expose **jamais** l'objet session. La **synchronisation d'horloge** part
immédiatement : un paquet `CK` de 36 octets avec `count = 0`.

**Refus.** Un `NO` du pair rejette `connect()` proprement, sans session ni
device connecté résiduels.

**Déconnexion.** `disconnect()` envoie bien un `BY` au pair, émet
`network:disconnected` **une seule fois** (le propriétaire unique du teardown
est le handler `disconnected`), et un second appel échoue explicitement.

**Flux entrant.** Note-on typé correctement ; running status **dans** un paquet
(delta-time VLQ + données sans statut) ; running status **reporté d'un paquet à
l'autre** via le bit P (RFC 6295) ; messages système (`0xF8`, SysEx complet)
transmis en octets bruts sans typage, pour que `handleRawMidi` les traite.

**Trames malformées.** Paquet de 3 octets, en-tête RTP nu, bit d'extension avec
en-tête tronqué, longueur MIDI annoncée à 4 095 pour 2 octets réels : **aucune
exception, aucun message émis, la session survit** et le paquet valide suivant
est parsé normalement.

**Émission.** `sendMidiMessage()` produit un paquet RTP `PT 97` avec un numéro
de séquence qui s'incrémente de 1, et la charge utile MIDI attendue. Vers une
IP non connectée : erreur explicite.

### 5.2 F-49 — se reconnecter abandonnait la session précédente (corrigé)

`connect(ip)` ne vérifiait pas qu'une session existait déjà pour cette IP :
`rtpSessions.set(ip, nouvelle)` **écrasait** l'ancienne. L'objet abandonné
gardait son intervalle de clock-sync et son chien de garde de réception armés,
`shutdown()` (qui itère `rtpSessions`) ne pouvait plus l'atteindre, et le pair
ne recevait **jamais** de `BY` — il conservait une session semi-ouverte que
plus personne ne pouvait clore. Un simple « reconnecter » depuis l'UI suffisait
à le déclencher.

**Correctif** (`NetworkManager.js`, début du `try` de `connect`) : fermer
explicitement la session précédente avant d'en créer une nouvelle.
**Preuve rouge → vert** : `first.state` valait `'established'`, vaut `'closed'`
avec ses deux timers à `null`.

### 5.3 F-50 — les sessions entrantes ne pouvaient pas aboutir (corrigé)

`_createResponderSession(ip)` fixait le port de contrôle **distant** à
`this.rtpMidiPort` — c'est-à-dire **notre propre port**. La réponse `OK` à une
invitation entrante partait donc vers `ip:5004` quel que soit le port réel du
pair. Or un initiateur AppleMIDI choisit son port de session et l'annonce par
Bonjour : macOS et iOS utilisent un **port dynamique**. En clair, **le rôle de
répondeur ne pouvait fonctionner que par coïncidence**, quand le pair utilisait
le même numéro de port que nous. Sur boucle locale, l'effet était encore plus
net : le manager s'envoyait la réponse à lui-même.

**Correctif** : `_handleControlInbound()` transmet `rinfo.port`, et
`_createResponderSession(ip, remoteControlPort)` s'en sert (port de données =
`+1`, convention AppleMIDI). Le défaut reste `this.rtpMidiPort`.
**Preuve rouge → vert** : le test « F-50 » fait écouter le pair sur des ports
**différents** de ceux du manager ; avant correctif il expirait sur l'attente
de l'`OK`, après il établit la session et `connectedDevices[ip].port` porte le
port réel du pair.

**Volet non corrigé — création de session non plafonnée.** Toute invitation
issue d'une adresse inconnue crée une session **et** arme un chien de garde de
10 s, sans authentification, sans plafond et sans limitation de débit. Preuve :
500 datagrammes d'invitation depuis 500 adresses ⇒ **500 sessions**. Sur un
réseau de scène ouvert, c'est une amplification triviale. `shutdown()` les
referme bien toutes, ce qui limite les dégâts à la durée de vie du processus.
Correctif proposé au §8.2 (plafond + fenêtre glissante) — non appliqué parce
qu'il fixe une politique, pas un bug.

### 5.4 F-51 — pas de numéro de séquence, et une auto-déclaration périmée

Le projet se déclare lui-même `degraded`. **Cette auto-déclaration est
honnête** — mais elle est fausse dans son détail, dans les deux sens.

**Ce qui est confirmé absent** (mesuré) :

| Scénario | Comportement mesuré | Conséquence musicale |
|---|---|---|
| Paquet **perdu** | Trou ni détecté ni signalé, aucune retransmission demandée | La note du paquet perdu est définitivement absente |
| Paquet **dupliqué** | **Le message est joué deux fois** | Double déclenchement de note |
| Paquets **réordonnés** | Émis dans l'ordre d'arrivée, sans tampon | Un note-off livré avant son note-on ⇒ **note tenue à vie** |

Le numéro de séquence RTP est lu (`parseRtpPacket` le renvoie) mais **jamais
utilisé** : ni détection de trou, ni dé-duplication, ni réordonnancement, ni
journal de récupération (RFC 6295 §5). C'est bien ce que « pas de journal »
annonce, et c'est un vrai risque de note bloquée sur un Wi-Fi de scène.

**Ce qui n'est PAS absent, contrairement à ce qui est écrit** : la poignée de
main d'invitation `IN`/`OK` **existe et fonctionne** (prouvée sur les deux
ports), et la **synchronisation d'horloge `CK` existe et fonctionne** (émission
`count=0` au moment de l'établissement, réponses `count=1`/`count=2` au pair).
Or trois endroits affirment le contraire :

- `src/core/Application.js:804` — *« no IN/OK, CK sync or journal »*
- `README.md:48` — *« no invitation handshake, clock synchronisation or journal/recovery »*
- `docs/audit/2026-09-07/15_HARDWARE_QA_CHECKLIST.md`, **HW-BJ-01** — reprend la même liste

**Le verdict de N02 reste `EXPERIMENTAL`** (le journal manque vraiment, et
c'est lui qui protège des pertes), mais le libellé doit être corrigé, sans quoi
l'opérateur sous-estime ce qui marche et **L15 attend un échec au mauvais
endroit**. Diff exact au §8.3.

---

## 6. §L — BLE MIDI

Le codec est couvert depuis août (`ble-midi-encode` / `ble-midi-decode`) ; ce
lot attaque **la machine à états et le cadrage réel des trames**. Les 45 tests
BLE existants restent verts après les deux correctifs.

### 6.1 F-48 — le décodeur perdait un message sur seize (P1, corrigé)

**C'est le finding le plus grave du lot, et il vivait dans un module coté
« 81 % de couverture ».**

Une trame BLE-MIDI est `[en-tête][horodatage][message]…`, l'octet
d'horodatage valant `0x80 | (ts & 0x7F)`. Quand les 7 bits bas de
l'horodatage tombent dans `0x78`–`0x7F`, **cet octet vaut `0xF8`–`0xFF`** — la
plage des messages System Real-Time. Le décodeur prenait le raccourci suivant à
la position « horodatage attendu » :

```js
if (b >= 0xf8) { emit([b]); i++; continue; }   // System Real-Time
```

Conséquence, à chaque fois que l'horodatage tombait dans cette plage :

1. un **faux message temps réel est émis** — MIDI Clock (`0xF8`), Active
   Sensing (`0xFE`) ou **System Reset (`0xFF`)** selon la milliseconde ;
2. l'octet de statut du vrai message est ensuite consommé **comme horodatage**,
   ses deux octets de données sont vus comme des octets errants — **le message
   est perdu**.

**Fréquence : 8 valeurs sur 128, soit ~6,25 % de tous les paquets entrants** —
une note sur seize, tirée au hasard par la milliseconde d'émission. Sur un
clavier BLE, cela se manifeste par des notes qui « sautent » sans motif, et par
des messages `0xFF`/`0xF8` fantômes injectés dans le pipeline.

Le spec Apple BLE-MIDI lève l'ambiguïté **par la position** : tout message, y
compris temps réel, est précédé de son propre octet d'horodatage. Un octet
`≥ 0xF8` à la position « horodatage » est donc **toujours** un horodatage.

**Correctif** (`BluetoothManager._handleIncomingMidi`) : le raccourci n'est
conservé qu'**à l'intérieur d'un SysEx**, où `consumeSysExPayload()` rend
délibérément la main à la boucle pour émettre un temps réel intercalé. Hors
SysEx, l'octet est consommé comme horodatage et le vrai temps réel est émis une
position plus loin, par la branche « statut » qui existait déjà.

**Preuves** : test « F-48 » (horodatages `0x7F` → `0xFF` et `0x78` → `0xF8` :
les deux messages passent, aucun temps réel fantôme), test « un vrai message
temps réel reste émis », et les 8 tests de `ble-midi-decode.test.js`
inchangés — dont « real-time byte between messages » et « real-time byte inside
a SysEx does NOT terminate it ».

**Pourquoi les tests existants ne l'ont pas vu :** ils utilisent tous
`TS = 0x80` (horodatage nul), la seule valeur qui ne peut jamais déclencher le
défaut.

### 6.2 F-53 — SysEx contaminé par une coupure, et épuisement silencieux

**(a) État de réassemblage non purgé (corrigé).** L'état SysEx par device
(`_bleParseState`) survivait à la déconnexion. Un SysEx interrompu en plein vol
(radio perdue au milieu d'un dump) était **recollé** aux octets de la session
suivante : le test injecte `F0 41 10` avant coupure puis `42 43 F7` après
reconnexion, et le décodeur émettait `[F0 41 10 42 43 F7]` — un message qui n'a
jamais existé sur le fil, avec un contenu de fabricant faux. **Correctif** :
purge de `_bleParseState` dans le handler `DISCONNECTED`. Preuve rouge → vert.

**(b) Épuisement de reconnexion silencieux (non corrigé).** Le back-off est
correct et vérifié **à la milliseconde** : tentatives à **2 000, 6 000, 14 000,
30 000 et 60 000 ms** après la coupure (délais 2/4/8/16/30 s), puis abandon
définitif — plus aucune tentative même après 120 s de plus, et `_reconnect`
purgé. Mais à l'abandon **aucun événement n'est émis** : seulement un
`logger.warn`. Le nom `reconnect_exhausted` n'existe que dans le client
WebSocket du frontend (`BackendAPIClient.js:284`), pas côté BLE. **L'opérateur
n'a aucun moyen de savoir que GMBoop a renoncé à son instrument** : l'UI le
montre déconnecté, exactement comme pendant les tentatives. Correctif proposé
au §8.4.

### 6.3 Le reste de la machine à états (PASS, niveau 4)

- Connexion refusée : rejet propre, aucun `bluetooth:connected`, aucun état
  résiduel dans `connectedDevices` / `pairedDevices`.
- Périphérique muet : expiration à **15 000 ms** exactement, **et** appel de
  `disconnect()` pour libérer le lien semi-ouvert.
- Coupure en plein flux : les messages suivants sont ignorés, `sendMidiData`
  échoue explicitement.
- Déconnexion **volontaire** : aucune reconnexion programmée. Déconnexion
  **inattendue** : back-off armé.
- Une reconnexion réussie annule le back-off et remet le compteur à zéro.
- **50 cycles déconnexion/reconnexion** : `_reconnect` vide, **nombre de timers
  identique**, **nombre d'écouteurs par événement identique**, aucun doublon
  dans `pairedDevices`. Pas de fuite.
- `cleanup()` annule les reconnexions en attente (aucune tentative tardive
  après 60 s d'avance d'horloge).
- Trames : plusieurs messages horodatés dans un paquet (émis dans l'ordre),
  running status **avec et sans** horodatage intercalé, running status qui **ne
  traverse pas** la frontière de paquet (conforme au spec Apple), en-tête
  invalide rejeté sans exception.
- **Horodatage qui recule / boucle sur 13 bits** : aucun message perdu ni
  réordonné (le décodeur ne se sert pas de l'horodatage pour ordonner —
  robustesse voulue). À l'émission, le bouclage `8191 → 0` conserve le bit 7 des
  deux octets de tête : la trame reste valide.

---

## 7. Couverture — avant / après

Mesure identique dans les deux cas : suite backend complète,
`--collectCoverageFrom='src/transports/**/*.js'` **et**
`--collectCoverageFrom='src/midi/devices/DeviceDiscovery.js'`.

| Module | Stmts avant | Stmts après | Δ |
|---|---|---|---|
| **`NetworkManager.js`** (1 077 l.) | **0,25 %** | **65,75 %** | **+65,5** |
| **`SerialMidiManager.js`** (912 l.) | **17,3 %** | **82,68 %** | **+65,4** |
| **`DeviceDiscovery.js`** (591 l.) | **3,9 %** | **54,48 %** | **+50,6** |
| `RtpMidiSession.js` (559 l.) | 76,5 % | 87,54 % | +11,0 |
| `BluetoothManager.js` (763 l.) | 81,0 % | 85,63 % | +4,6 |
| `AppleMidi.js` (158 l.) | 98,1 % | 98,14 % | = |
| **`src/transports/` (ensemble)** | **42,8 %** | **80,22 %** | **+37,4** |

Branches sur les trois cibles : `NetworkManager` 54,5 %, `SerialMidiManager`
74,2 %, `DeviceDiscovery` 33,7 %.

**Ce qui reste non couvert, et pourquoi :**

| Zone | Lignes | Raison |
|---|---|---|
| `NetworkManager.scanMDNS` / `scanSubnetIPs` / `readARPTable` | 100-182, 226-351 | `avahi-browse`, `ip neigh`, 254 sondes TCP — **environnement réseau requis**, pas du matériel MIDI |
| `DeviceDiscovery._detectCurrentPorts` branche `/proc/asound` | 354-4xx | Spécifique ALSA/Linux avec cartes son — **HW REQUIRED** |
| `DeviceDiscovery.getUsbSerialNumbers` | 165-249 | `/dev/serial/by-id`, `udevadm`, `/sys/class/sound` — **HW REQUIRED** |
| `SerialMidiManager._initialize` / `scanPorts` | 97-216 | `import('serialport')` réel + `SerialPort.list()` — **HW REQUIRED** |
| `BluetoothManager` chemins `NobleBleAdapter` | 303-340 | D-Bus / BlueZ — **HW REQUIRED** |

---

## 8. Recommandations non appliquées (hors périmètre du lot)

### 8.1 F-47 — silencer un device qui réapparaît (`src/midi/devices/DeviceManager.js`)

Point d'insertion : `_onDevicePortAdded(name, kind)`, après l'émission de
`device_connected`. Proposition (à arbitrer par L03/L05, qui possèdent ce
fichier) :

```js
// Un device qui réapparaît après un débranchement à chaud peut tenir des notes
// qu'aucun note-off n'atteindra jamais (audit L04 F-47). Silencer les 16 canaux
// à l'ouverture d'un port de SORTIE, une seule fois par (ré)apparition.
if (kind === 'output' && this._reconnectedDevices?.has(name)) {
  this._reconnectedDevices.delete(name);
  for (let ch = 0; ch < 16; ch++) {
    this.sendMessageEx(name, 'cc', { channel: ch, controller: 120, value: 0 });
    this.sendMessageEx(name, 'cc', { channel: ch, controller: 123, value: 0 });
  }
}
```

`_reconnectedDevices` est alimenté par `_pruneDisconnectedDeviceState()`, de
sorte que **la première** ouverture au démarrage n'envoie rien (on ne coupe pas
un instrument qui jouait avant nous) — seul un retour après disparition
déclenche le silence. Alternative moins intrusive : rendre le comportement
configurable (`devices.panicOnReconnect`, défaut `true`).

### 8.2 F-50 — plafonner les sessions AppleMIDI entrantes (`src/transports/NetworkManager.js`)

Non appliqué : c'est une politique, pas un bug. Proposition :

```js
const MAX_RESPONDER_SESSIONS = 8;      // une scène n'a jamais 500 pairs
_handleControlInbound(msg, rinfo) {
  let session = this.rtpSessions.get(rinfo.address);
  if (!session && isControlPacket(msg) && commandOf(msg) === CMD.INVITATION) {
    if (this.rtpSessions.size >= MAX_RESPONDER_SESSIONS) {
      this.logger.warn(`[NetworkManager] invitation from ${rinfo.address} refused: session cap`);
      return;
    }
    session = this._createResponderSession(rinfo.address, rinfo.port);
  }
  ...
```

À compléter, côté L10, par une réponse `NO` explicite plutôt qu'un silence.

### 8.3 F-51 — corriger le libellé `degraded` (deux fichiers partagés)

`src/core/Application.js:804` :

```diff
-          'RTP-MIDI is a simplified AppleMIDI implementation (no IN/OK, CK sync or journal)'
+          'RTP-MIDI implements the AppleMIDI IN/OK invitation and CK clock sync, but not the ' +
+          'RFC-6295 recovery journal: lost packets are not recovered, duplicated packets are ' +
+          'replayed and reordered packets are delivered out of order'
```

`README.md:48` :

```diff
-The current RTP-MIDI session is a **simplified, not-yet-conformant AppleMIDI implementation** (no invitation handshake, clock synchronisation or journal/recovery) and is not guaranteed to interoperate
+The current RTP-MIDI session performs the AppleMIDI invitation handshake (IN/OK on both the control and data ports) and clock synchronisation (CK), but has **no RFC-6295 recovery journal and ignores RTP sequence numbers** — a lost packet is not recovered, a duplicated packet is replayed, and a reordered packet is delivered out of order (a note-off before its note-on leaves a stuck note). It is not guaranteed to interoperate
```

### 8.4 F-53(b) — publier l'épuisement BLE (`src/transports/BluetoothManager.js`)

Non appliqué : ajouter un événement demande de câbler l'UI (hors périmètre).
Trois lignes dans `_scheduleReconnect` :

```diff
     if (entry.attempts >= this._maxReconnectAttempts) {
       this.logger.warn(`[BLE] giving up reconnection to ${address} after ${entry.attempts} attempts`);
       this._reconnect.delete(address);
+      // Sans cet événement, l'UI ne distingue pas « en cours de reconnexion »
+      // de « abandonné » (audit L04 F-53).
+      this.emit('bluetooth:reconnect_exhausted', { address, attempts: entry.attempts });
       return;
     }
```

À relayer par `Application.js` sur le WebSocket, sur le modèle de
`bluetooth:disconnected`, et à afficher par `RealtimeStatusToasts.js` — qui
sait déjà traiter un `reconnect_exhausted` côté WebSocket.

### 8.5 F-48 — dédupliquer le log « Output device not found »

`DeviceManager.sendMessageEx()`, dernière ligne : remplacer le `logger.warn`
inconditionnel par un log **une fois par device**, remis à zéro par
`device_connected` (le `Set` `_failedDevices` du scheduler fournit le modèle).

---

## 9. Ce qui reste **strictement matériel** — pour L15

`15_HARDWARE_QA_CHECKLIST.md` est déjà écrit et demande explicitement (§18) que
L04 dise ce qui devient redondant. Voici la réponse, point par point.

### 9.1 À RETIRER ou à rétrograder (désormais automatisé, niveau 4)

| Item L15 | Statut proposé | Pourquoi |
|---|---|---|
| **HW-K-05** — débranchement à chaud hors lecture | **Retirer** | `l04-device-discovery.test.js` couvre apparition, disparition, renommage, fantôme, 50 cycles. Ne reste sur matériel que **le délai de détection ≤ 10 s**, qui appartient à HW-K-01. |
| **HW-G04-01/02/03** — politiques `skip`/`pause`/`mute` | **Rétrograder en une seule vérification** | Le **statut** `disconnected` et l'événement unique `device_disconnected` sont prouvés automatiquement. Ce qui reste matériel est **musical** : « aucune note bloquée sur les **autres** sorties ». Garder une seule case, avec les trois politiques en variantes. |
| **HW-L-06** — back-off de reconnexion 2/4/8/16/30 s | **Retirer** | Vérifié à la milliseconde (2 000/6 000/14 000/30 000/60 000 ms). Le matériel n'ajoute rien. |
| **HW-L-07** — épuisement des tentatives | **Rétrograder** | L'arrêt après 5 tentatives et l'absence de fuite de timers/écouteurs sont prouvés sur 50 cycles. **Garder uniquement la mesure de RSS** (fuite mémoire côté pile BlueZ, hors JS). |
| **HW-M-05** — saturation du débit série | **Rétrograder** | Le plafond de 1 024 et la préservation des messages prioritaires sont prouvés. Reste matériel : **à partir de quel débit réel le UART casse** — c'est une limite physique à documenter, pas un bug. |

### 9.2 À AJOUTER (défauts trouvés ici, à confirmer sur matériel)

| Nouvel item | Session | Critère d'acceptation mesurable |
|---|---|---|
| **HW-K-04 → critère attendu : ÉCHEC** | 3 | Deux interfaces du même modèle ⇒ `device_list` ne montre **qu'une** entrée. C'est **F-46**, structurel (l'identité est le nom). Sur le modèle de HW-D05-02 : noter le `device_list` complet et laquelle des deux boucle. |
| **HW-G04-04 · Notes orphelines au rebranchement** | 3 | Tenir un accord de 4 notes sur un synthé **auto-alimenté**, débrancher le seul câble MIDI/USB pendant la lecture, rebrancher. **Critère attendu : les notes sonnent toujours** après le rebranchement (F-47). Mesure : à l'oreille + `aseqdump`. Noter combien de temps il faut à l'opérateur pour retrouver le silence, et par quel geste. |
| **HW-L-09 · Flux BLE soutenu — non-régression F-48** | 5 | Jouer **≥ 300 notes** en continu depuis le périphérique BLE. **Critère : 300 notes reçues (0 perdue) et aucun message `0xF8`/`0xFE`/`0xFF` fantôme** dans le moniteur. Avant correctif, ~6 % des notes disparaissaient et étaient remplacées par un temps réel fantôme. |
| **HW-L-10 · SysEx coupé en plein vol** | 5 | Lancer un dump SysEx depuis le périphérique, couper la radio au milieu, reconnecter, envoyer un message normal. **Critère : le message normal est reçu intact, aucun SysEx fabriqué n'apparaît** (F-53a). |
| **HW-M-10 · Désactivation / réactivation du MIDI série** | 4 | Réglages → Serial MIDI → désactiver, puis réactiver. **Critère : `serial_status` remontre le port ouvert et une note passe**, sans redémarrage du serveur (F-52a). |
| **HW-N-01 · Session AppleMIDI ENTRANTE** | 9 (avec BJ-01) | Depuis un Mac/iPad, **initier** la session vers le Pi (et non l'inverse). **Critère : la session s'établit et les notes passent.** Avant correctif c'était impossible dès que le pair n'utilisait pas le port 5004 (F-50) — or macOS/iOS annoncent un port dynamique par Bonjour. |
| **HW-N-02 · Perte / duplication sur Wi-Fi chargé** | 9 | Session RTP établie, saturer le Wi-Fi (transfert de fichier), jouer 2 min d'arpèges. **Critère attendu : ÉCHEC** — notes manquantes, doublées ou **note tenue à vie** (note-off réordonné). C'est la mesure qui chiffre F-51 sur le terrain : noter le nombre de notes bloquées par minute. |

### 9.3 À CORRIGER dans L15 (affirmations devenues fausses)

1. **HW-BJ-01** — son critère cite *« pas d'invitation IN/OK, pas de synchro
   CK, pas de journal »*. Les deux premiers points sont **faux** : la poignée de
   main et la synchro d'horloge existent et sont prouvées (§5.1). Nouveau
   libellé proposé : *« Critère attendu : la session s'établit et les notes
   passent. L'échec attendu est ailleurs — sous perte de paquets, voir
   HW-N-02 : il n'y a pas de journal de récupération. »*
2. **HW-L-04** — affirme que *« le codec de paquets BLE est déjà couvert par
   des tests unitaires, donc un échec ici pointe la machine à états, pas le
   codec »*. C'était **faux** : F-48 était précisément un défaut de codec que
   les tests unitaires ne voyaient pas (ils n'utilisaient que l'horodatage
   nul). Depuis le correctif, la phrase redevient vraie ; ajouter la référence
   à HW-L-09 comme filet.
3. **HW-L-02** — la note sur la durée de scan reste valide, sans changement.

### 9.4 Ce qui reste strictement matériel, sans substitut possible

**§K** : ouverture réelle d'un port ALSA · appariement `usb_serial_number` au
rebranchement (lecture de `/sys` et `/dev/serial/by-id`) · latence aller-retour
· duplex · saturation · branche `/proc/asound` de la détection hot-plug ·
**délai réel** de détection (le sondage à 5 000 ms n'est qu'une borne
théorique).
**§L** : radio, appairage, portée, gigue, MTU ATT réelle, deux périphériques
simultanés, adaptateur BlueZ/D-Bus, conflit BLE ↔ UART (F-169).
**§M** : cadrage électrique à 31 250 baud (le piège des pilotes qui arrondissent
à 38 400), opto-isolation, duplex, corruption d'octets, plusieurs UART
simultanés, contre-pression réelle du noyau.
**§N** : interopérabilité macOS / iOS / `rtpmidid`, Bonjour/mDNS
(`avahi-browse`), scan de sous-réseau, comportement sous perte de paquets
réelle.

---

## 10. Correctifs appliqués dans ce lot

Tous dans `src/transports/**`, tous prouvés par un test rouge → vert, aucun
fichier partagé touché.

| # | Fichier | Correctif | Test |
|---|---|---|---|
| F-48 | `BluetoothManager.js` — `_handleIncomingMidi` | Un octet `≥ 0xF8` à la position « horodatage » n'est plus lu comme du temps réel (raccourci conservé **dans** un SysEx uniquement) | `l04-ble-connection-state.test.js` « F-48 » |
| F-53a | `BluetoothManager.js` — handler `DISCONNECTED` | Purge de `_bleParseState` à la déconnexion | idem, « F-53 » |
| F-49 | `NetworkManager.js` — `connect()` | Fermeture explicite d'une session préexistante pour la même IP | `l04-network-manager.test.js` « F-49 » |
| F-50 | `NetworkManager.js` — `_handleControlInbound` / `_createResponderSession` | Réponse envoyée sur le **port source** de l'invitation | idem, « F-50 » |
| F-52a | `SerialMidiManager.js` — `setEnabled()` | Réactivation rouvre les ports configurés et relance le hot-plug | `l04-serial-port-management.test.js` « F-52 (suite) » |
| F-52b | `SerialMidiManager.js` — `openPort()` | `clearTimeout` du garde-fou de 10 s dans un `finally` | idem, « F-52 » |

**Non-régression** : suite backend complète **2 452 tests verts / 2 453**
(l'unique échec, `tests/lighting/effects-and-profiles.test.js`, appartient au
lot L02 en cours ; `tests/audit/l10-*` idem pour L10). Les 45 tests BLE préexistants
(`ble-midi-decode`, `ble-midi-encode`, `transports/bluetooth-manager`,
`noble-ble-connect-teardown`, `bluetooth-persistence-reconnect`) et les suites
RTP/AppleMIDI (`apple-midi-codec`, `rtp-midi-handshake`,
`rtp-midi-parser-fixes`, `rtp-midi-running-status`) sont verts **sans aucune
modification**.

---

## 11. Reproduction

```bash
# 110 tests (les 92 de ce lot + les 18 préexistants de bluetooth-manager), ~2 s
node --experimental-vm-modules node_modules/jest/bin/jest.js tests/transports/

# Couverture des trois modules cibles
node --experimental-vm-modules node_modules/jest/bin/jest.js --coverage \
  --collectCoverageFrom='src/transports/**/*.js' \
  --collectCoverageFrom='src/midi/devices/DeviceDiscovery.js' \
  --coverageReporters=text

# Un finding en particulier
node --experimental-vm-modules node_modules/jest/bin/jest.js tests/transports/ -t 'F-48'
```
