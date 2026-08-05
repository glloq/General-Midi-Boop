# Général Midi Boop — Instrument Recognition & Capability Protocol v2

Ce document remplace l'ancien protocole SysEx v1 (blocs 1/5/6/7, identité 52 octets)
précédemment décrit ici. Aucun chemin de compatibilité : les implémentations SysEx
existantes (Servo-Plucked-Strings, Stepper-Plucked-Strings) sont à l'état de brouillon
et s'alignent sur ce document.

> **État d'implémentation.** Cette spécification précède le code. GMB implémente
> aujourd'hui uniquement le consommateur d'identité v1 (parseur 52 octets dans
> `src/midi/devices/DeviceManager.js`). Les points d'impact concrets pour livrer le
> v2 sont détaillés en [§12](#12-état-dimplémentation-gmb--points-dimpact).

---

## 1. Principe

GMB sait déjà configurer un instrument à la main. Le protocole n'a donc pas pour
mission de *transmettre* les capacités mais de **reconnaître l'instrument de
façon stable**. Le reste est une optimisation.

| Niveau | L'instrument | GMB |
|---|---|---|
| **0 — Reconnaissance** | répond au bloc 1 (24 octets) | retrouve la config enregistrée pour cet exemplaire, ou la demande une fois |
| **1 — Descripteur** | sert en plus un descripteur de capacités | auto-configure, et suit les changements à chaud |

Le niveau 0 tient sur n'importe quel MCU : quelques dizaines de lignes, pas de
JSON, pas de RAM. Le niveau 1 ne sert qu'aux instruments dont la configuration
**change en cours de vie** — typiquement ceux qui ont une page web embarquée.

Il n'existe pas de bibliothèque de profils par modèle. Les firmwares du parc sont
modulaires et adaptatifs : le même binaire PlayMode peut être huit percussions,
un carillon ou un piano mécanique. Le modèle ne prédit pas les capacités. Il
reste une étiquette d'affichage, jamais une source de configuration.

**Source de vérité** — le profil actif de l'instrument : rien n'est codé en dur
dans le firmware, tout dérive de la configuration courante.

**Extensibilité** — un champ inconnu de GMB est ignoré silencieusement. Un
instrument futur ajoute des champs sans nouveau bloc, sans nouveau flag, sans
nouvelle version de protocole.

---

## 2. Bloc 1 — Handshake (SysEx binaire, 24 octets)

### Requête

```
F0 7D 00 01 00 F7
```

### Réponse

```
F0 7D 00 01 01 <proto_ver> <instance_id[5]> <firmware[3]>
   <descriptor_size[3]> <revision[5]> <flags> F7
```

| Offset | Taille | Champ | Description |
|---|---|---|---|
| 0-4 | 5 | En-tête | `F0 7D 00 01 01` |
| 5 | 1 | `proto_ver` | `02` pour ce document |
| 6-10 | 5 | `instance_id` | Identifiant **unique par exemplaire physique**, 32 bits en 7 bits |
| 11-13 | 3 | `firmware` | major, minor, patch |
| 14-16 | 3 | `descriptor_size` | Taille du descripteur en octets. `0` = niveau 0 |
| 17-21 | 5 | `revision` | Compteur de révision 32 bits |
| 22 | 1 | `flags` | bit 0 = HTTP disponible · bit 1 = notifications push |
| 23 | 1 | Fin | `F7` |

> **Note de spécification.** La trame fait exactement **24 octets** : `flags` est le
> dernier champ utile (offset 22), suivi de `F7`. Le brouillon initial mentionnait un
> champ `reserved[2]` avant `F7` (soit 26 octets) ; il a été retiré pour aligner le
> gabarit sur l'en-tête et la table d'offsets. Si des octets de réserve sont souhaités
> pour extension future, porter la trame à 26 octets et déplacer `F7` à l'offset 25.

### `instance_id` — point critique

C'est le pivot de tout le protocole : c'est lui qui rattache une configuration
enregistrée au bon exemplaire physique.

Le firmware actuel des cordes est **non conforme** :

```cpp
uint8_t deviceId[5] = {0, 0, 0, 0, 0};   // Capabilities.h
```

Deux exemplaires flashés avec le même binaire auraient le même identifiant, et
GMB leur appliquerait le même accordage, la même calibration, la même latence
mesurée. À dériver d'une source matérielle unique :

| Plateforme | Source |
|---|---|
| ESP32 | adresse MAC |
| RP2040, STM32 | identifiant unique gravé |
| Teensy | numéro de série |
| AVR sans ID matériel | 32 bits aléatoires tirés au premier boot, stockés en EEPROM |

`revision` est un ETag : GMB ne retélécharge le descripteur que si la valeur a
changé. Incrémenté par l'instrument à chaque modification de configuration.

Un appareil qui ne répond pas au bloc 1 n'est pas reconnu automatiquement.
Il reste utilisable : l'utilisateur le sélectionne dans une liste et GMB le
rattache au port. Aucune supposition n'est faite à sa place.

---

## 3. Bloc 0x10 — Transfert du descripteur (niveau 1 uniquement)

### Encodage

Descripteur JSON **restreint à l'ASCII** — tout caractère non-ASCII échappé en
`\uXXXX`. Tout octet est donc déjà 7-bit safe, **aucun packing nécessaire** :
surcoût nul, contre 14 % pour un packing 7-sur-8 classique.

### Requête / réponse

```
F0 7D 00 10 00 <chunk_index[2]> F7
F0 7D 00 10 01 <total_chunks[2]> <chunk_index[2]> <payload...> F7
```

`payload` : **200 octets maximum**, choisi pour rester sous la MTU de
réassemblage BLE-MIDI. Message complet : 210 octets max.

Un descripteur typique fait 1 à 2 ko, soit 5 à 10 segments, une seule fois à la
connexion. Négligeable même en BLE, et sans objet en DIN où le débit utile
(~3 ko/s) l'absorbe en moins d'une seconde.

L'instrument doit pouvoir servir un segment arbitraire. Deux stratégies
admises, indistinguables sur le fil :

- **statique** — document figé en PROGMEM/flash, accès aléatoire trivial ;
- **dynamique** — document rendu en RAM depuis le profil actif, pour les cartes
  qui ont la mémoire.

### Gestion d'erreur

- Timeout par segment : `comm_timeout` (défaut 5000 ms), 3 tentatives.
- Si `revision` change en cours de transfert, GMB **redémarre le transfert**.
  L'instrument sert les segments depuis un snapshot figé afin de ne jamais
  mélanger deux versions du profil.
- JSON invalide ou tronqué → repli sur le niveau 0.

---

## 4. Bloc 0x11 — Notification de changement

Émis spontanément par l'instrument, direction `0x02`.

```
F0 7D 00 11 02 <revision[5]> <change_flags> F7
```

| Bit | Nom |
|---|---|
| 0 | `IDENTITY_CHANGED` |
| 1 | `INSTRUMENTS_CHANGED` |
| 2 | `TIMING_CHANGED` |
| 3 | `RESTART_REQUIRED` |

Pour les transports sans voie de retour fiable, GMB relit le bloc 1 toutes les
30 s et compare `revision`. La notification est une optimisation, jamais une
dépendance.

---

## 5. Descripteur — structure

```json
{
  "gmb_descriptor": 2,
  "revision": 42,
  "device": { "name": "Atelier — flûte 6 trous", "model": "Servo-Flute-GMB" },
  "instruments": [ /* 1 à 16 entrées */ ]
}
```

`model` est une étiquette d'affichage. GMB n'en déduit **aucune** capacité.

### 5.1 Deux règles transverses

**`configured`** — état explicite par instrument.

```json
{ "channel": 0, "configured": false }
```

Un PlayMode au premier boot, une Servo-Flute sans table de doigtés : l'instrument
existe mais n'est pas défini. GMB bascule alors en saisie manuelle **sans
écraser** une configuration antérieure. Sans ce champ, GMB auto-configurerait du
vide.

**Champ absent = inconnu, jamais zéro.** Un instrument peut déclarer son
accordage sans connaître encore sa latence. Il omet le champ plutôt que
d'inventer une valeur par défaut, et GMB laisse la main à l'utilisateur sur ce
point précis.

### 5.2 Entrée instrument

```json
{
  "channel": 0,
  "configured": true,
  "name": "Ukulele",
  "gm_program": 24,
  "type": "guitar",
  "subtype": "nylon",
  "notes": { ... },
  "voices": [ ... ],
  "polyphony": { ... },
  "timing": { ... },
  "expression": { ... },
  "resources": [ ... ],
  "physical": { ... }
}
```

`type` et `subtype` reprennent les clés textuelles de `InstrumentTypeConfig.js`
plutôt que des identifiants numériques : lisible, débogable, et sans table de
correspondance à maintenir des deux côtés — celle-là même qui a produit le bug
`encodeDescriptor`.

### 5.3 `notes`

```json
"notes": { "mode": "range", "min": 55, "max": 88 }
"notes": { "mode": "discrete", "list": [36, 38, 40, 42, 46] }
```

Avec attributs par note lorsque nécessaire :

```json
"notes": {
  "mode": "discrete",
  "list": [60, 62, 64],
  "attributes": { "air_direction": ["blow", "draw", "blow"] }
}
```

### 5.4 `voices` — unités physiques d'émission

Une voix = une unité matérielle qui ne peut produire qu'une note à la fois
(une corde, un trou d'harmonica, un tuyau).

```json
"voices": [
  { "id": "s1", "notes": { "mode": "range", "min": 67, "max": 79 } },
  { "id": "s2", "notes": { "mode": "range", "min": 60, "max": 72 } }
]
```

Optionnel : un instrument à actionneurs indépendants peut l'omettre.

### 5.5 `polyphony` — polyphonie et contraintes

```json
"polyphony": {
  "max": 4,
  "constraints": [
    { "type": "one_note_per_voice" },
    { "type": "same_attribute", "attribute": "air_direction" },
    { "type": "adjacent_voices", "max_span": 1 }
  ]
}
```

| Contrainte | Sémantique | Instrument |
|---|---|---|
| `one_note_per_voice` | une note max par voix | cordes, harmonica |
| `same_attribute` | les notes simultanées partagent la valeur d'un attribut | harmonica (souffle/aspiration) |
| `adjacent_voices` | voix actives contiguës, écart max `max_span` | cordes frottées (doubles cordes) |
| `max_simultaneous_per_group` | plafond par groupe nommé | bancs d'actionneurs sur une même alimentation |

Remplace le scalaire `polyphony` du bloc 6, incapable d'exprimer « 3 notes, à
condition d'être toutes de même direction d'air ».

### 5.6 `timing` — modèle en deux phases

Tous les instruments du parc séparent un geste **lent et silencieux** d'un geste
**rapide et sonore** : frette puis pincement, doigts puis valve, coulisse puis
air, positionnement puis contact d'archet.

```json
"timing": {
  "prepare": { "base_ms": 8, "per_semitone_ms": 1.4, "max_ms": 180, "silent": true },
  "excite":  { "latency_ms": 12, "jitter_ms": 2 },
  "min_note_ms": 40,
  "rearticulation_ms": 25,
  "release_ms": 15
}
```

**`prepare`** — positionnement mécanique, durée fonction de l'intervalle depuis
la position courante. `silent: true` signifie que l'excitation est
indépendamment coupable, donc que le geste est inaudible : GMB peut **anticiper**
grâce à son lookahead de lecture de fichier, et cette latence **n'entre pas**
dans la compensation.

**`excite`** — déclenchement sonore, fixe, non masquable. **Seule valeur qui
alimente `sync_delay`.**

Conséquences pour GMB :

- lookahead requis = `max(prepare.max_ms)` sur les instruments actifs ;
- en jeu live (clavier virtuel), `prepare` n'est plus masquable et devient une
  latence réelle — à signaler dans l'UI ;
- une note dont le `prepare` dépasse le temps disponible depuis la note
  précédente sur la même voix est **injouable** : l'adaptation la supprime ou la
  réassigne, elle ne la joue pas en retard.

`silent: false` décrit un déplacement audible (coulisse sous air continu) : le
glissando devient une caractéristique déclarée, non un défaut.

### 5.7 `expression`

```json
"expression": {
  "cc": [1, 2, 7, 11],
  "pitch_bend": { "supported": true, "range_semitones": 2 },
  "channel_aftertouch": true,
  "poly_aftertouch": false,
  "velocity": true
}
```

Corrige le trou du bloc 6, qui ne savait déclarer que des CC — le slide whistle
gère pitch bend et aftertouch, dont aucun n'est un CC.

### 5.8 `resources` — ressources consommables

Abstraction unique couvrant l'archet, le réservoir à piston, les pompes et le
soufflet.

```json
"resources": [
  { "id": "bow", "unit": "ms_of_sound", "capacity": 3000,
    "refill_ms": 120, "refill_audible": true, "refill_during_note": true }
]
```

- `capacity` : durée de jeu continue avant réapprovisionnement obligatoire ;
- `refill_during_note` : le geste peut-il survenir pendant une note tenue
  (changement de sens d'archet : oui, avec artefact) ;
- `refill_audible` : GMB peut préférer placer le geste sur un silence.

Permet à l'adaptation de découper les notes longues aux bons endroits plutôt que
de laisser l'instrument décrocher.

### 5.9 `physical` — extensions par famille

Espace de noms libre, ignoré si inconnu. Remplace le bloc 7 et ses versions.

```json
"physical": {
  "family": "strings",
  "string_count": 4,
  "fret_count": 12,
  "frets_per_string": [12, 12, 12, 12],
  "fretless": false,
  "capo": 0,
  "tuning": [67, 60, 64, 69],
  "string_order": "normal",
  "selection": {
    "mode": "hybrid",
    "cc_string": 20, "cc_string_min": 1, "cc_string_max": 4, "cc_string_offset": 0,
    "cc_fret": 21,   "cc_fret_min": 0,  "cc_fret_max": 12,  "cc_fret_offset": 0
  }
}
```

Reprend le contenu utile du bloc 7 v2 déjà écrit dans le firmware cordes, sans le
mécanisme de versionnement qui n'avait aucune voie de négociation.

Autres familles : `winds` (tables de doigtés, débits min/nominal/max par note,
registres de suroctave), `percussion` (mapping note → actionneur, temps de
réarmement).

---

## 6. Arbitrage instrument / GMB

L'utilisateur peut régler la même valeur dans la page web de l'instrument **et**
dans GMB. Les deux sont légitimes.

**Règle** — GMB peut surcharger n'importe quel champ déclaré. La surcharge est
marquée dans l'UI. Elle **saute dès que l'instrument change la valeur de ce
champ**, l'instrument connaissant son état physique mieux que GMB.

### Mise en œuvre

`revision` est global et ne dit pas quel champ a bougé. Plutôt que d'imposer une
révision par champ à l'instrument, **le diff est calculé côté GMB** :

```
À chaque nouveau descripteur reçu :
  pour chaque champ f surchargé par l'utilisateur :
    si descripteur_precedent[f] existe et != descripteur_nouveau[f] :
        supprimer la surcharge de f          # l'instrument a bougé
    sinon :
        conserver la surcharge de f          # rien n'a changé côté instrument
```

GMB conserve donc le descripteur précédent en cache, ce qu'il fait déjà pour la
comparaison de `revision`. Coût côté instrument : **nul**.

Granularité : le champ feuille. `tuning` est traité comme une valeur unique — si
une seule corde change, toutes les surcharges d'accordage sautent.

Cas particuliers :

- **premier descripteur reçu** (instrument passé du niveau 0 au niveau 1 par mise
  à jour firmware) : aucun précédent à comparer, rien ne prouve que l'instrument
  a changé — les valeurs saisies manuellement sont **conservées** en tant que
  surcharges ;
- **champ passé de déclaré à absent** : l'instrument ne sait plus, la surcharge
  est conservée ;
- **`configured` repasse à `false`** : toutes les surcharges de cet instrument
  sont conservées, GMB revient en saisie manuelle.

---

## 7. Comportement de GMB

```
1. Bloc 1 → instance_id, proto_ver, descriptor_size, revision, flags
2. Chercher instance_id dans la base locale
3. Si descriptor_size == 0            → niveau 0 : config enregistrée, ou saisie manuelle. Fin.
4. Si revision inchangée              → réutiliser le descripteur en cache. Fin.
5. Si flags bit 0 et HTTP joignable   → GET /gmb/descriptor.json
   Sinon                              → transfert segmenté bloc 0x10
6. Valider le JSON. Échec             → repli niveau 0.
7. Diff contre le descripteur précédent → purger les surcharges concernées (§6)
8. Pour chaque instrument :
     si configured == false → saisie manuelle, ne rien écraser
     sinon → appliquer les champs déclarés, capabilities_source = "descriptor"
9. Lookahead requis = max(timing.prepare.max_ms)
10. Diffuser instruments_configured
11. Écouter le bloc 0x11, ou relire le bloc 1 toutes les 30 s
```

---

## 8. Prérequis matériels par transport

| Transport | Reconnaissance auto | Remarque |
|---|---|---|
| USB-MIDI | oui | bidirectionnel par nature |
| BLE-MIDI | oui | segments limités à 200 octets pour le réassemblage |
| WiFi RTP-MIDI | oui | implémentation GMB signalée `degraded` ; préférer le flag HTTP |
| DIN IN + OUT | oui | |
| **DIN IN seul** | **non** | pas de voie de retour → sélection manuelle dans une liste |

Aucun mécanisme de découverte automatique ne peut exister sans canal de retour :
un instrument filaire destiné à être reconnu doit prévoir un MIDI OUT.

---

## 9. Hors descripteur

Réglages côté GMB, jamais transmis par l'instrument :

| Champ | Raison |
|---|---|
| `sync_delay` | mesuré par la calibration micro de GMB |
| `comm_timeout` | réglage interne GMB |
| `octave_mode` | préférence d'affichage utilisateur |
| `mac_address`, `usb_serial_number` | découverts par la pile système |
| `tab_algorithm` | préférence de traitement tablature |
| SoundFont SF2 | choix utilisateur |

---

## 10. Tableau de conformité

| Instrument | Niveau visé | voices | contraintes | prepare / excite | resources | physical |
|---|---|---|---|---|---|---|
| Stepper-Plucked-Strings | 1 | par corde | `one_note_per_voice` | frettage / pincement | — | `strings` |
| Servo-Plucked-Strings | 1 | par corde | `one_note_per_voice` | frettage / pincement | — | `strings` |
| Cordes frottées | 1 | par corde | `one_note_per_voice` + `adjacent_voices` | positionnement+approche / contact | archet | `strings` |
| harmonica_Midi | 1 | par trou | `one_note_per_voice` + `same_attribute` | valve / air | réservoirs | `winds` |
| Servo-Flute-GMB | 1 | 1 | mono | doigts / valve | pompes | `winds` |
| servo-Melodica-GMB | 1 | par touche | `one_note_per_voice` | touche / pompe | soufflet | `winds` |
| PlayMode-GMB | 1 | par actionneur | `max_simultaneous_per_group` | — / frappe | — | `percussion` |
| Drums-Engine-GMB | 1 | par actionneur | `max_simultaneous_per_group` | — / frappe | — | `percussion` |
| slide_Whistle-GMB | **0** | 1 | mono | coulisse (180 ms) / air | — | `winds` |

Le slide whistle tourne sur Leonardo avec une configuration figée à la
compilation (`settings.h`, LUT) : le niveau 0 lui suffit, l'utilisateur saisit
ses capacités une fois dans GMB. Rien n'interdit de le passer au niveau 1 plus
tard avec un descripteur statique en PROGMEM.

Aucun instrument du parc n'exige de champ hors de ce modèle.

---

## 11. Migration

1. **`instance_id` d'abord** — sans identifiant unique par exemplaire, rien ne
   fonctionne. Un patch par firmware, indépendant du reste.
2. Côté GMB : parseur + validateur JSON, base d'association `instance_id` →
   configuration, logique de diff des surcharges (§6). Points d'impact précis en
   [§12](#12-état-dimplémentation-gmb--points-dimpact).
3. Migrer les deux firmwares cordes pincées : supprimer les blocs 5/6/7/8 de
   `GmbSysEx.cpp`, sérialiser le JSON depuis `Profile`. Le `CapabilitySnapshot`
   existant est déjà la bonne abstraction — seule la sérialisation change,
   `buildSnapshot()` reste. Les deux fichiers étant identiques, un patch
   s'applique deux fois.
4. Définir les cordes frottées directement en v2.
5. Ajouter le bloc 1 aux six instruments qui n'ont rien (niveau 0, quelques
   dizaines de lignes), puis le descripteur là où la configuration est dynamique.

---

## 12. État d'implémentation GMB & points d'impact

Cette section documente la **vérification de compatibilité** avec le code actuel
du dépôt (branche `main`). Les artefacts firmware cités ailleurs (`GmbSysEx.cpp`,
`Capabilities.h`, `CapabilitySnapshot`, `buildSnapshot()`) vivent dans le dépôt
firmware séparé et ne sont pas vérifiables ici.

### 12.1 Ce que GMB fait déjà aujourd'hui

- **Émission de la requête.** `DeviceManager.sendIdentityRequest()` envoie déjà
  `F0 7D 00 01 00 F7` (bloc 1, identique au v2) **plus** la MIDI Universal Identity
  Request `F0 7E <id> 06 01 F7`. → La requête sortante est déjà conforme ; rien à
  changer côté émission.
- **Réponse.** `DeviceManager.parseIdentityReply()` ne décode **que** le format v1
  à 52 octets (`deviceId[5]` · `name[32]` · `firmware[3]` · `features[5]`, plus
  6 feature-flags : noteMap…stringConfig). Il **rejette toute trame ≠ 52 octets** ;
  une réponse v2 à 24 octets est donc aujourd'hui ignorée.
- **Décodage 7-bit.** `decode7BitTo32Bit()` (5 octets → 32 bits) existe et est
  directement réutilisable pour `instance_id` et `revision`.
- **Persistance.** `saveSysExIdentity()` (`InstrumentSettingsDB`) écrit les colonnes
  `sysex_*` de la table `instruments_latency`, clé (`device_id`, `channel`), puis
  diffuse `device_identity` à l'UI (`DeviceSettingsModal._handleSysExIdentity`).
- **Blocs 5/6/7 : aucun consommateur.** Les seuls SysEx émis sont le bloc 1 et
  l'Universal Identity. Le « flux d'auto-configuration » des blocs 5/6/7 était
  documentaire, jamais implémenté — **leur retrait ne casse aucun code en service.**
- **`capabilities_source`.** Le champ existe mais n'est renseigné qu'à `'manual'`
  en pratique ; aucun chemin ne produit `'sysex'`.

### 12.2 Points d'impact pour livrer le v2 (côté GMB)

| Emplacement | Changement |
|---|---|
| `src/midi/devices/DeviceManager.js` · `parseIdentityReply()` | Remplacer le parseur 52 octets par le handshake 24 octets (`proto_ver`, `instance_id`, `firmware`, `descriptor_size`, `revision`, `flags`). Réutiliser `decode7BitTo32Bit()` tel quel. |
| `src/midi/devices/DeviceManager.js` (nouveau) | Transfert segmenté bloc 0x10 (réassemblage, `comm_timeout`, 3 tentatives), écoute du bloc 0x11, relecture du bloc 1 toutes les 30 s. |
| Nouveau service | Parseur + validateur JSON du descripteur ; logique de diff des surcharges (§6) ; base d'association `instance_id → configuration`. |
| Schéma `instruments_latency` | La contrainte `capabilities_source CHECK(... IN ('manual','sysex','auto'))` **rejette `'descriptor'`** (§7 étape 8). → migration `033_*` pour ajouter la valeur `'descriptor'` (ou réutiliser `'sysex'`). Ajouter le stockage de `instance_id` (la colonne `sysex_device_id` peut servir), `revision`, cache descripteur, et surcharges par champ. |
| Frontend `DeviceSettingsModal.js` | L'affichage identité lit les 6 `featureFlags` v1 — à adapter au nouveau `flags` (HTTP/push) + `descriptor_size`/`revision`. |
| `wiki/Instrument-Developer-Guide.md` | Miroir décrivant encore les blocs v1 1/5/6/7 — à retirer / refondre pour rester cohérent avec ce document. |

Les commandes `device_identity_request` / `sysex_identity_request` /
`device_save_sysex_identity` (`src/api/commands/DeviceCommands.js`) restent
valides (elles émettent la requête et persistent l'identité).

### 12.3 Cohérence des clés & valeurs (vérifiée)

- `type` / `subtype` du descripteur = clés de `InstrumentTypeConfig.js`
  (`piano`, `guitar`/`nylon`, `strings`, …). Aucune table de correspondance à
  maintenir. ✔
- `notes.mode ∈ {range, discrete}` correspond exactement à
  `note_selection_mode CHECK(... IN ('range','discrete'))`. ✔
- Champs « hors descripteur » (§9) — `sync_delay`, `comm_timeout`,
  `octave_mode`, `mac_address`, `usb_serial_number`, `tab_algorithm`, SF2 —
  tous présents dans le schéma / la logique existants, et restent côté GMB. ✔
- `physical.family` (`strings` / `winds` / `percussion`) est un espace de noms
  nouveau, ignoré si inconnu — sans conflit avec les familles internes
  (`InstrumentTypeConfig.families`). ✔
