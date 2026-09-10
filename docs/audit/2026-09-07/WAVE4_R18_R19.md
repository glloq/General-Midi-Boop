# WAVE 4 · R18 + R19 — le panic complet, et les notes bloquées au débranchement

**Findings traités :** **F-45** (P2, `03_MIDI_CORE.md` §4) · **F-47** (P2,
`04_TRANSPORTS.md` §3.3) · **F-48 volet observabilité** (déluge de logs,
`04_TRANSPORTS.md` §3.4, recoupé par **F-132** de L12) · **écart mineur D05**
(politiques divergentes entre le limiteur de `DeviceManager` et la file série).

**Thème de la vague :** la robustesse de scène. Les deux findings ci-dessous
ont la même conséquence physique — **un instrument qui continue de sonner et
qu'on n'a plus aucun moyen d'arrêter**.

---

## 0. Résumé

| | Avant | Après |
|---|---|---|
| Contenu du panic | CC 120 + 123, 32 messages | **CC 120 + 121 + 123, 48 messages** |
| Sustain verrouillé | survit au panic | **relâché** (121, avant le 123) |
| Panic global | inexistant (`deviceId` obligatoire ; sans lui, cible `undefined`) | **`deviceId` optionnel ⇒ toutes les sorties activées, les 4 transports** |
| Débranchement | rien n'est envoyé | **rafale de silence sur le port encore ouvert, avant `close()`** |
| Rebranchement | rien n'est envoyé | **rafale rejouée, une seule fois, et seulement après une disparition** |
| Arrêt du serveur | rien n'est envoyé (alors que `Application.stop()` l'annonce) | **chaque sortie est silencée avant fermeture** |
| Log « Output device not found » | **1 ligne par message** (200 msg ⇒ 200 lignes) | **1 ligne, puis un compteur, puis 1 ligne de synthèse au retour** |
| Channel Mode ≥ 120 | limiteur : `>= 120` · série : liste figée {120,121,123} | **`>= 120` des deux côtés** |

---

## 1. R18 / F-45 — la séquence de panic retenue, et pourquoi

### 1.1 Ce qui était cassé

`midi_panic` envoyait **CC 120 (All Sound Off)** puis **CC 123 (All Notes
Off)** sur les 16 canaux d'**un** appareil. Jamais **CC 121 (Reset All
Controllers)**.

MIDI 1.0 définit *All Notes Off* comme ignoré — ou, sur les implémentations
plus clémentes, **différé** — tant que la pédale de sustain (CC 64) est
enfoncée. Un instrument qui implémente **123 mais pas 120** continue donc de
sonner après un panic. Ce n'est pas un cas d'école : c'est le profil courant
des firmwares Arduino / microcontrôleur des instruments DIY que ce projet
vise. **Le panic était un no-op exactement dans la situation pour laquelle il
existe.**

Second volet : il n'y avait **aucun panic global**. `midi_reset` diffusait
déjà à toutes les sorties quand `deviceId` était omis ; `midi_panic` et
`midi_all_notes_off` l'exigeaient (schéma `requireDeviceId`) et, s'il
manquait, adressaient littéralement `undefined`. Faire taire un orchestre de
N instruments coûtait N commandes WebSocket, à travers un limiteur plafonné à
60 trames/s (F-07).

### 1.2 La séquence retenue : **120 → 121 → 123**, sur les 16 canaux

```
canal 0 : CC 120 = 0   CC 121 = 0   CC 123 = 0
canal 1 : CC 120 = 0   CC 121 = 0   CC 123 = 0
…
canal 15: CC 120 = 0   CC 121 = 0   CC 123 = 0        → 48 messages, 144 octets
```

**Pourquoi ces trois-là.**

1. **120 — All Sound Off.** Coupe les oscillateurs immédiatement, sans égard
   pour les enveloppes de relâchement ni pour la pédale. Sur un instrument qui
   l'implémente, rien d'autre n'est nécessaire.
2. **121 — Reset All Controllers.** Déverrouille la **pédale de sustain**
   (CC 64), la sostenuto, la modulation, le pitch bend. C'est le message qui
   manquait.
3. **123 — All Notes Off.** Relâche les notes tenues.

**Pourquoi 121 AVANT 123 — et non l'inverse.** Le diff proposé par l'audit
(§6.5 de `03_MIDI_CORE.md`) suggérait `120, 123, 121`. Il ajoute bien le 121
manquant, mais **trop tard** :

- Lecture littérale de la spec (« All Notes Off est **ignoré** tant que la
  pédale est enfoncée ») : le 123 est **jeté**, et le 121 qui suit ne
  déverrouille qu'une pédale dont les note-off ont déjà été perdus. **Le panic
  reste un no-op** — exactement le défaut qu'on cherche à corriger.
- Lecture clémente (les note-off sont **différés** jusqu'au relâchement de la
  pédale) : `120, 123, 121` fonctionne, et `120, 121, 123` aussi.

`120, 121, 123` est donc correct dans les **deux** lectures, sans contrepartie :
Reset All Controllers ne remet à zéro ni le volume, ni le pan, ni le programme.
C'est la seule divergence assumée avec le diff de l'audit, et elle est dans le
sens de la sûreté.

**Pourquoi PAS un `CC 64 = 0` explicite.** Ce serait la ceinture-et-bretelles
pour un firmware qui n'implémenterait ni 120 ni 121. Mais **CC 64 est du trafic
ordinaire** pour les deux exemptions de priorité du produit : le limiteur de
`DeviceManager` exempte `controller >= 120`, la file d'écriture série
priorise `controller >= 120`. Un CC 64 ajouté à la rafale serait donc le seul
message **susceptible d'être supprimé sous charge** — précisément dans le
scénario (panic pendant une lecture dense) où il compterait. 121 est le moyen
standard, exempt, de relâcher la pédale. Décision documentée, pas oubliée.

**Taille de la rafale : 48 messages au lieu de 32.** Tous les contrôleurs sont
`>= 120`, donc l'exemption existante du limiteur les couvre sans la toucher —
vérifié sous un limiteur saturé à 10 msg/s après 500 note-on : les 48 messages
passent (`status: 'sent'`), un CC 7 ordinaire est bien throttlé.

### 1.3 Le panic global

`midi_panic` et `midi_all_notes_off` acceptent désormais un `deviceId`
**optionnel**. Sans lui, la cible est **toutes les sorties activées**, énumérées
par `DeviceManager.getDeviceList()` — l'agrégateur qui réunit déjà USB,
Bluetooth, réseau (RTP) et série. Un seul chemin de code, quatre transports.

- Réponse : `{ success: true, targets: N }` (alignée sur `midi_reset`).
- Une entrée seule (`output: false`) n'est jamais adressée.
- Un device désactivé par l'opérateur (`enabled: false`) est ignoré, comme pour
  `midi_reset` — cohérent avec `sendMessageEx`, qui refuse tout MIDI à un
  device désactivé.
- Le note-gate du routeur est vidé **une fois** par commande, pas une fois par
  device.

Schéma (`src/api/commands/schemas/midi.schemas.js`) : `midi_panic`,
`midi_all_notes_off` et `midi_reset` partagent maintenant le même
`optionalDeviceId`. Un `deviceId: ''` reste refusé — chaîne vide ≠ « tout ».

> **L01 n'est pas défait.** L'exemption du limiteur WebSocket
> (`src/api/WebSocketServer.js`) porte sur le **nom de commande**, pas sur le
> payload : `midi_panic` reste exempt, avec ou sans `deviceId`. Le rendre
> global le rend même **moins** coûteux pour le limiteur : une trame au lieu de N.

### 1.4 Ce qui reste à faire côté UI (hors périmètre)

`public/js/features/LoopManagerOutputRouter.js` boucle encore sur les devices
et envoie un `midi_panic` par sortie (lignes 103 et 132). Ça fonctionne
toujours, mais une seule trame sans `deviceId` suffirait désormais, et il
n'existe **aucun bouton « panic général »** dans la SPA. `public/js/**` est
tenu par un autre agent de cette vague : signalé, pas modifié.

---

## 2. R19 / F-47 — les notes bloquées au débranchement

### 2.1 Ce qui était cassé

Entre le dernier `noteon` et la fermeture du port, **rien** n'était envoyé :
ni note-off, ni CC 120, ni CC 123. Et **au rebranchement, rien non plus**. Un
synthé auto-alimenté — le cas normal, seul le câble MIDI/USB est débranché —
continuait de sonner ses notes tenues jusqu'à ce qu'un humain déclenche un
panic… sur un device qui n'est plus joignable.

S'y ajoutait un `logger.warn('Output device not found')` **par message** vers le
device disparu : 200 messages ⇒ 200 lignes ; sur une lecture dense à 500 msg/s,
le journal devient inutilisable au moment précis où on en a besoin.

### 2.2 Trois gestes, dans l'ordre où la scène les impose

**(a) Couper pendant que c'est encore possible.** `DeviceDiscovery` possède la
fermeture du port ; `DeviceManager` possède ce qu'on y dit. Un
`setOutputPreCloseHook(fn)` relie les deux : `_closeRemovedOutput()` appelle le
hook **avant** `output.close()`, avec le port encore ouvert.

- Si le lien survit (renumérotation de hub, rechargement de pilote, client ALSA
  qui s'en va), les 48 messages passent.
- Si le câble est réellement arraché, la première écriture lève et la tentative
  s'arrête là : **une tentative, pas 48**, et une ligne d'info qui dit
  explicitement que des notes peuvent rester bloquées. Rien ne remonte en
  exception jusqu'au chemin de hot-plug.

Le hook n'est **pas** branché sur `scanAndReopen()`, qui ferme des ports
**sains** pour les rouvrir : un `device_refresh` au milieu d'un morceau ne doit
pas faire taire l'orchestre. Testé.

**(b) Repartir propre au retour.** Tout device dont la **sortie** a disparu
pendant que le processus tournait est mémorisé dans `_disconnectedOutputs`. À
sa réapparition, il reçoit la rafale complète, **une seule fois**, puis est
oublié. La **première ouverture au démarrage n'envoie rien** : on ne coupe pas
un instrument qui jouait avant nous. C'est l'arbitrage que L04 avait laissé
ouvert au §8.1 — tranché ici en faveur du silence-au-retour-seulement, sans
réglage supplémentaire à comprendre pour l'opérateur.

**(c) Faire taire à l'arrêt.** `Application.stop()` documente depuis toujours
`deviceManager.close()` comme « silences instruments — no stuck notes ».
**Rien n'était envoyé.** `close()` purge maintenant chaque sortie ouverte (et
chaque device virtuel) avant de fermer. Même famille de trou, même correctif.

### 2.3 Le journal borné

`sendMessageEx` : **une** ligne `warn` la première fois qu'un device est
introuvable, puis un compteur silencieux ; au retour du device, **une** ligne
de synthèse chiffrée (« *N further message(s) were dropped while it was
gone* »), et le compteur est réarmé pour la prochaine disparition. Le
**statut renvoyé est inchangé** (`SEND_STATUS.DISCONNECTED`) : `PlaybackScheduler`
garde sa politique `skip`/`pause`/`mute` intacte.

Mesuré : 1 000 messages ⇒ **1 ligne** + 999 comptés (contre 1 000 lignes). Deux
devices disparus ⇒ 2 lignes, pas 2 × N.

### 2.4 L'écart mineur D05, réconcilié

`SerialMidiManager._isPrioritySerial()` ne priorisait que {120, 121, 123} et
{`noteoff`, `reset`, `stop`}, là où le limiteur de `DeviceManager` exempte
**tout** `controller >= 120` et le jeu complet `PRIORITY_MSG_TYPES`
({`noteoff`, `reset`, `clock`, `start`, `stop`, `continue`}). Deux politiques
pour la même classe de message, donc deux comportements pour les mêmes octets
selon le câble. La file série importe désormais `PRIORITY_MSG_TYPES` et teste
`controller >= 120` : **une seule règle, deux côtés**.

---

## 3. Preuve de parité sur les quatre transports

### 3.1 Comment la parité est obtenue — par construction, pas par quatre correctifs

Une seule définition de la rafale : `src/midi/messages/SilenceSequence.js`
(`PANIC_CONTROLLERS`, `buildSilenceSequence()`, `silenceSequenceBytes()`).
Tous les émetteurs la consomment :

| Émetteur | Fichier | Chemin d'émission |
|---|---|---|
| Bouton panic / all-notes-off | `src/api/commands/MidiCommands.js` | `deviceManager.sendMessage` |
| Silence au retour d'un device | `DeviceManager.silenceDevice()` | `sendMessageEx` |
| Purge avant fermeture (USB) | `DeviceManager._onOutputPortLost()` | `_sendToOutput` (port mourant) |
| Purge avant fermeture (série) | `SerialMidiManager._flushSilenceBeforeClose()` | `port.write` direct |
| Arrêt du serveur | `DeviceManager.close()` | `_sendToOutput` |

`sendMessageEx` est le **seul** endroit qui sait joindre un port USB, un
périphérique BLE, une session RTP-MIDI ou un UART. Faire passer le silence par
lui, plutôt que par un cas particulier par transport, est ce qui rend la parité
structurelle : elle ne peut pas dériver sans que `sendMessageEx` ne dérive.

### 3.2 Matrice de parité — **émission** (extension de `03_MIDI_CORE.md` §3)

La matrice §3 de L03 couvre le **décodage** (4 chemins d'entrée, même
entonnoir). Voici son pendant en **émission** : une même intention musicale,
quatre chemins de sortie, comparaison des **octets sur le fil**.

Référence : `silenceSequenceBytes()` = 144 octets, `B0 78 00 · B0 79 00 ·
B0 7B 00 · B1 78 00 … BF 7B 00`.

| Intention | USB (easymidi) | Série (UART) | BLE (Apple BLE-MIDI) | RTP (RFC 6295) | ≡ ? |
|---|---|---|---|---|---|
| Panic (`midi_panic`) | ✅ 48 × `send('cc')` → `Bn cc 00` | ✅ 144 octets écrits, tous prioritaires | ✅ 48 trames, `Bn cc 00` après en-tête + horodatage | ✅ 48 paquets, re-décodés en `Bn cc 00` | **✅** |
| Panic global (sans `deviceId`) | ✅ | ✅ | ✅ | ✅ | **✅** (via `getDeviceList()`) |
| All Notes Off | ✅ 16 × `B n 7B 00` | ✅ | ✅ | ✅ | **✅** |
| Silence au rebranchement | ✅ `_onDevicePortAdded` | ✅ `serial:connected` | ✅ `bluetooth:connected` | ✅ `network:connected` | **✅** |
| Mémorisation de la disparition | ✅ hook pré-fermeture | ✅ `serial:disconnected` | ✅ `bluetooth:disconnected` | ✅ `network:disconnected` | **✅** |
| Purge **avant** fermeture du lien | ✅ port encore ouvert | ✅ `closePort` / hot-plug / `shutdown` | ⚠️ impossible¹ | ⚠️ impossible¹ | ⚠️ |
| Channel Mode ≥ 120 non throttlé | ✅ limiteur `>= 120` | ✅ file série `>= 120` (corrigé) | ✅ limiteur | ✅ limiteur | **✅** |

¹ **La seule divergence restante, et elle est physique.** Le BLE et le RTP
n'apprennent la coupure qu'**après** coup : `BLE_EVENTS.DISCONNECTED` est émis
quand le lien GATT est déjà tombé, une session RTP se termine sur une absence
de réponse. Il n'existe pas d'instant « le lien va tomber, écrivons encore » à
exploiter. Sur ces deux transports, le filet est donc le **silence au retour**
(ligne 4), qui, lui, est identique aux quatre. C'est une limite du transport,
pas du correctif — et elle vaut aussi pour l'USB quand le câble est
réellement arraché.

### 3.3 Comment la parité est vérifiée

`tests/audit/r18-panic-complete.test.js` §4 fait sortir la rafale par les
**vrais** gestionnaires et compare les octets récupérés au bout :

- **USB** — `DeviceManager._sendToOutput` → capture des appels `output.send`,
  ré-encodés par une réplique de `easymidi.parseMessage`, avec un **test de
  garde** qui relit `node_modules/easymidi/index.js` et échoue si la réplique
  dérive (même dispositif que la suite de parité en décodage de L03).
- **Série** — vrai `SerialMidiManager`, vraie file d'écriture, octets capturés
  au `port.write`. Vérifié au passage : la file est **vide** en fin de rafale
  (tout est passé en prioritaire), `droppedWrites === 0`.
- **BLE** — vrai `BluetoothManager` + `InMemoryBleAdapter`, en-tête et
  horodatage Apple BLE-MIDI déballés, charge MIDI comparée.
- **RTP** — vrai `RtpMidiSession.createRtpPacket()`, puis re-décodage par
  `parseRtpPacket()` / `parseMidiPayload()` du produit (pas une
  réimplémentation), `payloadType === 97` vérifié.

Les quatre rendent **exactement** `silenceSequenceBytes()`.

`tests/audit/r19-hotplug-silence.test.js` §2 refait le même exercice pour le
**silence au rebranchement**, avec les vrais gestionnaires et les bancs livrés
par L04 : faux énumérateur pour l'USB, `InMemoryBleAdapter` pour le BLE,
classe `SerialPort` bouchon pour l'UART, sessions RTP locales.

---

## 4. Fichiers

### Créés

| Fichier | Rôle |
|---|---|
| `src/midi/messages/SilenceSequence.js` | Source unique de la rafale (ordre, canaux, octets) + la justification de l'ordre |
| `tests/audit/r18-panic-complete.test.js` | **23 tests** — séquence, panic global, schéma, parité d'émission sur 4 transports |
| `tests/audit/r19-hotplug-silence.test.js` | **25 tests** — purge avant fermeture, silence au retour, parité 4 transports, purge série, journal borné |

### Modifiés

| Fichier | Correctif |
|---|---|
| `src/api/commands/MidiCommands.js` | Panic 120/121/123 · `deviceId` optionnel ⇒ diffusion à toutes les sorties · `targets` renvoyé · idem `midi_all_notes_off` |
| `src/api/commands/schemas/midi.schemas.js` | `midi_panic` / `midi_all_notes_off` / `midi_reset` partagent `optionalDeviceId` |
| `src/midi/devices/DeviceManager.js` | `silenceDevice()` · `_onOutputPortLost()` · `_onDeviceOutputRestored()` · `_attachTransportLifecycleHandlers()` · journal borné (`_noteMissingOutput` / `_flushMissingOutputLog`) · `close()` silence avant fermeture |
| `src/midi/devices/DeviceDiscovery.js` | `setOutputPreCloseHook()`, appelé par `_closeRemovedOutput()` avant `close()` (et **pas** par `scanAndReopen`) |
| `src/transports/SerialMidiManager.js` | `_isPrioritySerial` : `PRIORITY_MSG_TYPES` + `controller >= 120` · `_flushSilenceBeforeClose()` sur `closePort`, hot-plug et `shutdown` |

### Suites d'audit inversées (le défaut qu'elles documentaient est corrigé)

| Suite | Tests inversés |
|---|---|
| `tests/audit/l03-panic-conformance.test.js` | « panic does NOT send 121 » → **envoie 121** · « the sustain … is never cleared » → **est relâché** · « panic targets ONE device » → **atteint toutes les sorties** · burst 32 → **48** · « 122/124-127 NOT prioritised » → **le sont** ; 4 tests ajoutés (ordre 121<123, all-notes-off global, note-gate, device désactivé) |
| `tests/transports/l04-hotplug-during-playback.test.js` | « le débranchement n'envoie AUCUN note-off » → **purge 48 messages avant `close()`** · « un warn par message » (200) → **1 warn + 199 comptés** · « au rebranchement, aucun panic » → **rafale rejouée** ; 3 tests ajoutés (port injoignable, log par device, première ouverture muette) |
| `tests/devicemanager-auto-identity.test.js` | Contexte factice complété : la méthode empruntée `_onDevicePortAdded` a un collaborateur de plus |

---

## 5. Reproduire

```bash
# Les deux suites de la vague (aucun matériel, aucune base)
node --experimental-vm-modules node_modules/jest/bin/jest.js tests/audit/r18 tests/audit/r19
#   → Test Suites: 2 passed · Tests: 48 passed

# Les suites d'audit inversées
node --experimental-vm-modules node_modules/jest/bin/jest.js \
  tests/audit/l03-panic tests/transports/l04-hotplug
#   → 2 suites, 28 tests, verts

# Non-régression backend complète
node --experimental-vm-modules node_modules/jest/bin/jest.js
#   → Test Suites: 214 passed, 2 failed*, 216 total · Tests: 3 025 passed, 2 failed*
#     * `r6-offline-first` / `l11-offline-first` : « 193 balises <script> » → 194.
#       public/index.html a gagné une balise du fait d'un autre lot de la vague 4.
#       Hors périmètre R18/R19 (aucun fichier public/** touché ici).

npx vitest run                 # → 90 fichiers / 1 634 tests, verts
npx eslint src/ public/js/ tests/   # → 0 erreur
npx tsc --noEmit                    # → clean
npx prettier --check <fichiers touchés>  # → clean
```

Départ de vague : 210 suites / 2 904 tests backend · 88 / 1 604 frontend.
Arrivée (mesurée en fin de lot, les autres agents de la vague 4 ayant ajouté
leurs suites en parallèle) : **216 suites / 3 027 tests backend**,
**90 fichiers / 1 634 tests frontend**. Apport propre à R18 + R19 :
**2 suites, 48 tests** neufs, plus 28 tests d'audit inversés.

---

## 6. Ce qui reste non testable sans matériel — pour la checklist L15

À verser à `15_HARDWARE_QA_CHECKLIST.md`. Tout ce qui suit est **exécuté et
vérifié en simulation**, mais ne prouve rien sur le comportement d'un
instrument réel face à ces messages : c'est le firmware de l'instrument qui
décide, et c'est exactement l'inconnue que F-45 mettait en cause.

| # | Vérification | Palier | Critère mesurable |
|---|---|---|---|
| **HW-R18-01** | **Le panic fait taire un sustain verrouillé.** Sur un instrument DIY qui implémente 123 **sans** 120 : tenir un accord, enfoncer/latcher CC 64 (127), relâcher les touches, déclencher le panic. | 1 (un instrument) | **Silence complet**. Avant R18 : l'accord continuait. Mesure : à l'oreille + `aseqdump -p <port>` pour confirmer la réception de 120/121/123 dans cet ordre. |
| **HW-R18-02** | **L'ordre 121 → 123 est bien celui qui compte.** Rejouer HW-R18-01 en inversant l'ordre à la main (`amidi -S`) : 120, 123, 121. | 1 | Noter si l'instrument se tait quand même. C'est **la** mesure qui départage les deux lectures de la spec sur ce firmware ; à consigner par modèle. |
| **HW-R18-03** | **Panic global sur un orchestre.** ≥ 3 instruments sur ≥ 2 transports différents (p. ex. USB + UART + BLE), tous en train de jouer ; une seule trame `midi_panic` **sans `deviceId`**. | 2 (orchestre) | **Tous** se taisent, en une commande. Chronométrer le délai entre la trame et le dernier son. |
| **HW-R18-04** | **Panic sous charge réelle.** Panic pendant une lecture dense (> 300 msg/s) vers le même port. | 1 | Les 48 messages arrivent (`aseqdump`), aucun n'est throttlé. Vérifie l'exemption `>= 120` sur du vrai débit UART à 31 250 bauds. |
| **HW-R19-01** | **Notes orphelines au débranchement (le test d'origine G04.3).** Tenir un accord de 4 notes sur un synthé **auto-alimenté**, arracher le seul câble MIDI/USB pendant la lecture. | 1 | Attendu : **l'instrument se tait** si la purge pré-fermeture a pu passer ; s'il continue, noter **combien de temps** s'écoule avant le rebranchement, et vérifier que le silence revient **au rebranchement**. Les deux issues sont valides — la seconde est la limite physique documentée au §3.2. |
| **HW-R19-02** | **Le silence au retour ne coupe pas un instrument tiers.** Démarrer GMBoop **pendant** qu'un instrument joue de son propre chef (arpégiateur interne, séquenceur embarqué). | 1 | L'instrument **continue** : la première ouverture n'envoie rien. |
| **HW-R19-03** | **Débranchement BLE et RTP.** Éteindre le périphérique BLE / débrancher le réseau pendant une lecture, puis rétablir. | 1-2 | Au retour : silence. Pendant la coupure : **1 seule ligne** `Output device not found` par device dans `journalctl`, pas des milliers. |
| **HW-R19-04** | **Arrêt du serveur en plein accord.** `systemctl stop gmboop` pendant qu'un accord sonne. | 0-1 | Silence à l'arrêt. Vérifie la purge de `DeviceManager.close()` sur du vrai matériel. |
| **HW-R19-05** | **UART : la purge pré-fermeture passe à 31 250 bauds.** 144 octets ≈ 46 ms de fil. Débrancher le port série pendant une lecture. | 1 (fil GPIO14→15) | Les 144 octets sortent-ils avant que le pilote ne ferme ? Mesure : boucler TX→RX sur un second Pi / adaptateur et capturer. **C'est la seule mesure de latence de la purge**, et elle conditionne l'utilité réelle du geste (a) sur UART lent. |

**Deux réserves honnêtes à porter dans la checklist :**

1. La purge pré-fermeture est **best effort par nature**. Sur un câble
   réellement arraché, aucune écriture ne part — c'est vrai sur les quatre
   transports, et le code le dit dans son journal (« *unreachable, nothing could
   be flushed (notes may hang until it returns)* »). Le filet réel est le
   silence au retour.
2. `Reset All Controllers` remet aussi à zéro la **modulation** et le **pitch
   bend**. Sur un instrument réglé en direct pendant le concert, un panic
   remet donc ces contrôleurs à leur valeur par défaut. C'est le comportement
   attendu d'un panic — mais c'est un changement de comportement observable
   par rapport à l'ancienne rafale 120/123, à mentionner dans les notes de
   version.

---

## 7. Renvois croisés

- **L01 / F-07.** L'exemption WebSocket de `midi_panic` porte sur le nom de
  commande : elle reste intacte, et un panic global consomme désormais **une**
  trame au lieu de N. Rien à refaire de ce côté.
- **L12 / F-132.** Le déluge « Output device not found » était une part
  mesurable du spam de log (53 % du volume mesuré par L12). Borné ici. Les
  autres sources de spam ne sont pas dans ce périmètre.
- **L04 / §8.4 F-53(b).** L'événement `bluetooth:reconnect_exhausted` reste non
  publié : `DeviceManager` sait maintenant réagir à `bluetooth:connected` /
  `bluetooth:disconnected`, mais l'UI ne distingue toujours pas « en cours de
  reconnexion » d'« abandonné ». Inchangé, toujours ouvert.
- **Vague 4 / UI.** Aucun bouton « panic général » dans la SPA, et
  `LoopManagerOutputRouter.js` boucle encore device par device. Le backend est
  prêt ; le câblage est du ressort du lot frontend.
