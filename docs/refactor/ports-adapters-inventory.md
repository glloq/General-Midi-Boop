# Inventaire des ports/adapters candidats — Phase 4 (P1-4.3)

**Date** : 2026-04-17
**Scope** : zones où le couplage à l'infrastructure (drivers MIDI, BLE,
GPIO, réseau) est le plus fort. L'objectif n'est PAS de tout convertir,
mais d'**identifier la zone pilote** pour P1-4.5 et de cartographier la
roadmap d'extension ultérieure.

## Zones étudiées

| Zone | Fichier(s) | LOC | Dépendances natives | Score couplage |
|------|-----------|-----|---------------------|----------------|
| Bluetooth (BLE-MIDI) | `src/managers/BluetoothManager.js` | 647 | `node-ble` | **fort** |
| Serial MIDI | `src/managers/SerialMidiManager.js` | 747 | `fs` (read /dev), spawn alsamidi | **fort** |
| RTP MIDI / Network | `src/managers/NetworkManager.js`, `src/managers/RtpMidiSession.js` | 813 + 392 | `net`, `dgram`, `child_process` (avahi) | **fort** |
| Lighting | `src/managers/LightingManager.js` + 8 drivers `src/lighting/*` | 971 + ~2500 | pigpio (GPIO), DMX, Art-Net, sACN, OSC, MQTT, HTTP | **fort** |
| Device discovery | `src/midi/DeviceDiscovery.js` | — | `fs`, `child_process` (aplaymidi) | moyen |
| Device aggregation | `src/midi/DeviceManager.js` | 794 | dépend des managers ci-dessus | faible (orchestration pure) |

## Analyse par zone

### 1. BluetoothManager (`src/managers/BluetoothManager.js`)

**État actuel** :
- Importe directement `createBluetooth` de `node-ble`.
- Maintient l'état des appareils BLE-MIDI découverts.
- Émet sur `EventEmitter` interne : `device-discovered`, `connected`,
  `disconnected`, `midi-message`.

**Problèmes** :
- Tests intégration impossibles sans hardware BLE.
- `node-ble` est lié à `bluetoothd` (DBus Linux) → non portable
  (mac/Win) et exige privileges root.
- Mock pour tests unitaires : il faut stuber tout le module
  `node-ble`, fragile.

**Port recommandé** :
```js
// src/midi/ports/BluetoothPort.js (interface)
//   discover() : Promise<DeviceDescriptor[]>
//   connect(deviceId) : Promise<void>
//   disconnect(deviceId) : Promise<void>
//   sendMidi(deviceId, message: Uint8Array) : Promise<void>
//   on('midi-message', handler)
//   on('device-discovered', handler)
//   ...
```

Adapter prod : `NobleBleAdapter` (wrapping `node-ble`).
Adapter test : `InMemoryBleAdapter` (fixtures, événements simulés).

**Verdict** : excellent candidat pour **P1-4.5 pilote**. Surface API
claire (5 méthodes), dépendance native pénible à mocker, valeur de test
immédiate.

### 2. SerialMidiManager (`src/managers/SerialMidiManager.js`)

**État actuel** :
- Lit `/dev/snd/midiC*D*` directement via `fs`.
- Lance `aplaymidi`/`amidi` via `spawn`.
- Pas de dépendance npm native — Linux ALSA only.

**Problèmes** :
- Lié à ALSA (Linux pur).
- Difficile à tester sans devices réels.

**Port recommandé** :
```js
// src/midi/ports/SerialMidiPort.js
//   listDevices() : Promise<DeviceDescriptor[]>
//   open(deviceId) : Promise<Handle>
//   close(handle) : Promise<void>
//   send(handle, bytes: Uint8Array) : Promise<void>
//   onReceive(handle, callback)
```

Adapter prod : `AlsaSerialAdapter`. Adapter test :
`InMemorySerialAdapter`.

**Verdict** : bon candidat, mais **après** Bluetooth (le couplage est
moins ramifié, donc moins urgent à isoler).

### 3. Network / RTP MIDI

**État actuel** :
- `NetworkManager` orchestre sockets UDP/TCP + Avahi (mdns).
- `RtpMidiSession` implémente le protocole RTP MIDI.

**Problèmes** :
- Discovery Avahi via `child_process` (lourd à mocker).
- Sockets bruts → tests d'intégration nécessitent un peer.

**Verdict** : **reporter**. La complexité du protocole RTP MIDI
mérite un ADR dédié avant tout port/adapter, et la priorité Phase 4
n'inclut pas RTP MIDI dans les drivers nommés du plan §4 P2 §10.

### 4. Lighting (`LightingManager` + 9 drivers `src/lighting/`)

**État actuel** :
- `BaseLightingDriver` est **déjà un port implicite** : tous les
  drivers (GPIO, DMX, Art-Net, sACN, OSC, MQTT, HTTP) en héritent.
- L'API est claire : `setColor`, `clear`, `init`, `dispose`.
- Le driver `GpioLedDriver` / `GpioStripDriver` dépend de `pigpio` au
  runtime mais l'import est lazy.

**Constat** : le pattern ports/adapters EST DÉJÀ EN PLACE pour
lighting. Aucune refactorisation nécessaire — seulement à documenter
comme « modèle » pour les autres zones.

**Verdict** : **rien à faire**. Citer comme exemple de réussite dans
l'ADR-005 (à venir si P1-4.5 produit un cadre formel).

### 5. DeviceManager (`src/midi/DeviceManager.js`)

**État actuel** : orchestrateur — agrège la liste des devices fournis
par BluetoothManager, SerialMidiManager, NetworkManager.

**Verdict** : **pas un candidat port/adapter**. C'est un service
domaine qui consomme des ports. Sa refactorisation viendrait
naturellement après l'introduction de `BluetoothPort`,
`SerialMidiPort`, etc. (il prendrait alors les ports en injection au
lieu de manager concrets).

## Priorisation

| # | Zone | Effort | Gain | Choix |
|---|------|--------|------|-------|
| 1 | BluetoothManager | moyen (~3-5j) | élevé (testabilité immédiate) | **P1-4.5 pilote** |
| 2 | SerialMidiManager | moyen (~3-5j) | élevé | second |
| 3 | Lighting | aucun | déjà fait | référence/exemple |
| 4 | NetworkManager | élevé (~5-8j) | moyen | reporter |
| 5 | DeviceManager | faible (~1-2j post 1+2) | dépend | enchaînement |

## Recommandation pour P1-4.5

**Implémenter** :

1. `src/midi/ports/BluetoothPort.js` — interface (JSDoc + signature
   contractuelle, pas une classe).
2. `src/midi/adapters/NobleBleAdapter.js` — wrap `node-ble`. Reprend
   tel quel le code actuel de `BluetoothManager` mais sous une
   surface API contrainte.
3. `src/midi/adapters/InMemoryBleAdapter.js` — pour tests, simule
   un set d'appareils.
4. `BluetoothManager` devient un **service domaine** qui prend un
   `BluetoothPort` en injection (au lieu d'importer `node-ble`).
   `Application.js` choisit l'adapter selon l'environnement.

Tests à ajouter :
- Test domaine de `BluetoothManager` avec `InMemoryBleAdapter` (CI vert).
- Test contrat `BluetoothPort` (contract test que tout adapter doit
  satisfaire — runner DRY).

## Hors scope P1-4.5

- Refactoriser `SerialMidiManager` (suit dans P1-4.5b si nécessaire).
- Toucher au `Lighting` (déjà conforme).
- Toucher au `NetworkManager` / `RtpMidiSession` (reporter,
  complexité du protocole).
- Refactoriser `DeviceManager` (à faire **après** que ≥ 2 ports
  hardware soient en place — sinon refactor à blanc).

## Prochaines étapes P1-4

- **P1-4.5** (suite) : implémenter `BluetoothPort` + `NobleBleAdapter`
  + `InMemoryBleAdapter` + 1 test domaine, sans casser le comportement
  observable (snapshots WS verts, BLE-MIDI fonctionnel).
- **P1-4.1 / P1-4.2** : extension du découpage domaine pour
  `routing` (hors playback), `devices`, `files` — services métier
  qui consomment les repositories de Phase 2 et restent indépendants
  du transport WS.
