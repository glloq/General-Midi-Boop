# Audit — Reconnaissance & capacités des instruments (2026-08-05)

Portée : la chaîne complète « reconnaissance des capacités des instruments connectés »
et son implémentation dans le reste du projet. Trois axes audités en parallèle puis
recroisés : **ingestion** (reconnaissance à la connexion), **stockage/validation**,
**consommation/enforcement** (les capacités contraignent-elles réellement la sortie MIDI ?).

Contexte : fait suite au passage au protocole v2 (`docs/SYSEX_IDENTITY.md`,
`parseGmbHandshake`, migration `033`).

---

## Verdict

L'**enforcement en lecture de fichier** est en réalité assez complet : plage de notes,
notes discrètes, polyphonie, intervalles/durées mini, `sync_delay` et CC cordes sont
tous appliqués au runtime dans `PlaybackScheduler._dispatchToDevice`. Les problèmes
sont ailleurs, sur trois plans :

1. **La reconnaissance n'est jamais automatique** — aucun transport ne sonde à la
   connexion ; l'identité parsée n'alimente aucune configuration de capacités.
2. **Plusieurs capacités déclarées ne contraignent pas la sortie** — `supported_ccs`,
   `octave_mode`/`scale_root` (moteur aveugle), le route-through live, les cordes
   (audible), les voix secondaires.
3. **La validation à l'écriture a des trous** — pas de schéma d'enveloppe pour les
   commandes `instrument_*`, validateur jamais appelé, chemins qui peuvent violer une
   contrainte `CHECK` ou perdre des données.

Plus deux bugs pré-existants confirmés dans la persistance/affichage de l'identité.

---

## Suivi — correctifs livrés dans cette PR

| Point | État | Commit |
|---|---|---|
| P1-1 mapping `saveSysExIdentity` | ✅ corrigé | `fix(capabilities)` |
| P1-2 affichage modal identité | ✅ corrigé | `fix(capabilities)` |
| P1-4 perte de configs à l'INSERT | ✅ corrigé | `fix(capabilities)` |
| P1-5 écritures non validées | ✅ durci (enum + `MidiListParser` sur le chemin primaire) | `fix(capabilities)` |
| P2-1 reconnaissance jamais auto | ✅ sonde debouncée + `device_connected` + timeout/retry | `feat(devices)` |
| P2-5 `octave_mode`/`scale_root` moteur aveugle | ✅ snap de gamme dans le moteur (`ScaleSnapper`) | `feat(playback)` |
| P2-3 route-through live sans enforcement | ✅ clamp stateless partagé (`NoteEnforcement`) | `feat(routing)` |
| P2-2 pipeline descripteur v2 (cœur) | ✅ cœur pur livré (`DescriptorProtocol` : réassemblage 0x10 / validation §5 / diff des surcharges §6) — câblage transport+DB restant | `feat(instrument)` |

**Restant** (non couvert par cette PR) : P2-2 (**cœur pur livré** ci-dessus ;
reste le câblage — requête/timeout bloc `0x10`, écoute `0x11`, base
`instance_id→config`, application du descripteur aux capacités), P2-4
(`supported_ccs` non filtré — volontairement laissé optionnel), P2-6 (schémas
d'enveloppe `instrument_*` — le durcissement DB est fait, le schéma déclaratif
reste), P2-7 (voix secondaires côté moteur), P2-8 (cordes → flux audible), P2-9
(lecture de `comm_timeout` — le timeout/retry est ajouté mais utilise une valeur
par défaut, pas encore `comm_timeout`), et les points P3.

Enforcement **stateful** (polyphonie / timing) sur le route-through live : non
porté (nécessite un état de notes par flux côté routeur) — documenté dans
`NoteEnforcement`.

---

## P1 — Défauts fonctionnels (cassés aujourd'hui)

### P1-1 · `saveSysExIdentity` : mauvais noms de champs → `sysex_family/model/version` toujours `NULL`
`InstrumentSettingsDB.saveSysExIdentity` lit `identity.deviceFamily`,
`identity.deviceFamilyMember`, `identity.softwareRevision`
(`src/persistence/tables/InstrumentSettingsDB.js:406-416,431-443`), mais les parseurs
émettent `family` / `model` / `firmwareVersion` (`DeviceManager._parseUniversalIdentityReply`)
ou pas du tout (v1/v2). Résultat : `sysex_family`, `sysex_model`, `sysex_version` sont
**toujours** écrits `null` ; `sysex_manufacturer_id` n'est renseigné que pour une réponse
Universal, `sysex_device_id` que pour v1/v2.
**Repro** : brancher un instrument qui répond à l'Universal Identity → seule la ligne
brute (`sysex_raw_response`) est utile, famille/modèle/version perdus.
**Reco** : mapper les champs réellement émis par les parseurs (`family`→`sysex_family`,
`model`→`sysex_model`, `firmwareVersion`→`sysex_version`), ou renommer côté parseur.

### P1-2 · `DeviceSettingsModal` : panneau d'identité toujours vide
`DeviceSettingsModal._handleSysExIdentity` lit `data.name` / `data.firmware` /
`data.protocol` à la racine (`public/js/features/DeviceSettingsModal.js:252-254`), alors
que le broadcast a la forme `{device, identity, timestamp}` — les champs sont sous
`data.identity.*` (`DeviceManager.js:944-948`). Le panneau affiche donc en permanence
« Inconnu — Firmware: - — Protocole: - ».
**Reco** : lire `data.identity.deviceName || data.identity.manufacturerName`,
`data.identity.firmwareVersion`, `data.identity.protocol`.

### P1-3 · `saveSysExIdentity` fige le canal à 0
`DeviceManager.js:936` appelle `saveSysExIdentity(deviceName, 0, …)` en dur → un appareil
multi-canal écrase toujours la même ligne `instruments_latency`.
**Reco** : router selon le canal réel quand il est connu (ou stocker l'identité au niveau
device, pas par canal).

### P1-4 · Perte silencieuse de configs à l'INSERT de `updateInstrumentCapabilities`
La branche INSERT (première écriture pour un `device+channel` sans ligne) **omet**
`hands_config`, `bagpipe_config`, `accordion_config`, `harmonica_config`,
`min_note_interval`, `min_note_duration` (`src/persistence/tables/InstrumentCapabilitiesDB.js:202-231`)
— seule la branche UPDATE les persiste. L'UI principale contourne via `instrument_save_all`
(écrit d'abord les settings), mais la commande autonome `instrument_update_capabilities`
perd ces champs au premier enregistrement.
**Reco** : aligner les colonnes de l'INSERT sur celles de l'UPDATE.

### P1-5 · Écritures de capacités pouvant violer une contrainte `CHECK` / stocker du JSON invalide
Aucun `instrument.schemas.js` n'existe (`src/api/commands/schemas/` n'a ni instrument, ni
virtual, ni voices) → `JsonValidator.validateByCommand` retombe sur le défaut permissif.
Sur le chemin primaire :
- `note_selection_mode` écrit verbatim (`InstrumentCapabilitiesDB.js:224` + update) → peut
  violer `CHECK IN('range','discrete')` (`migrations/001_baseline.sql:400`).
- `capabilities_source` écrit verbatim (`:229`/`:176`) → une valeur hors
  `('manual','sysex','auto')` viole la `CHECK` (`:402`). **Directement pertinent v2** : un
  client envoyant `'descriptor'` ferait échouer l'écriture.
- `supported_ccs`/`selected_notes` fournis comme chaîne non-JSON → stockés verbatim
  (`:114-116,132-134`) → violent `json_valid` (`:399,401`).
- CC/notes non entiers en plage (`[1.5]`, `[null]`) passent les boucles `<0||>127`
  (`:108-112,124-127`) et sont sérialisés — MIDI malformé mais `json_valid` satisfait.
Le chemin **par voix** est immunisé (`parseValidMidiList`) ; le chemin **primaire** ne l'est pas.
**Reco** : ajouter les schémas d'enveloppe `instrument_*` et/ou durcir les gardes DB
(enum `note_selection_mode`/`capabilities_source`, `parseValidMidiList` sur le primaire).

---

## P2 — Capacités non appliquées / lacunes structurelles

### P2-1 · Reconnaissance jamais déclenchée à la connexion
`sendIdentityRequest` (`DeviceManager.js:783`) a **un seul** appelant : la commande
`device_identity_request` (`src/api/commands/DeviceCommands.js:201-202`), invoquée
uniquement depuis le frontend. Les chemins de connexion (`addInput`/`addOutput`
`DeviceManager.js:244,290`, `scanDevices:161`, hot-plug `DeviceDiscovery.js:533,556`) ne
l'appellent jamais. L'événement `device_connected` (`constants.js:274`) est **abonné mais
jamais émis**. Le seul déclencheur automatique est frontend : la sonde bulk de
`LoopEditorModal._probeKeyboardIdentities:1527` à l'ouverture de l'éditeur / onglet piano.
→ En headless, ou si cet écran n'est jamais ouvert, **aucun** instrument n'est reconnu.
**Reco** : émettre `device_connected` et déclencher un `sendIdentityRequest` (debouncé)
à la connexion, avec `comm_timeout`/retries.

### P2-2 · Identité parsée mais inexploitée ; aucune auto-configuration
Au-delà de `saveSysExIdentity` + `broadcast('device_identity')`
(`DeviceManager.js:934-949`), rien. `featureFlags`, `flags`, `instanceId`,
`descriptorSize`, `revision`, `level` sont décodés (`:1071-1078,1147-1167`) et **lus par
aucun code aval**. Aucun `capabilities_source='sysex'`/`'auto'` n'est jamais produit
(seul `'manual'` l'est — voir P2-6).
**Reco** : c'est précisément la tranche pipeline v2 (§ *Reste pour v2* ci-dessous).

### P2-3 · Le route-through live n'applique aucune capacité
`MidiRouter.routeMessage` (`src/midi/routing/MidiRouter.js:263-308`) n'applique que les
filtres de route utilisateur (`passesFilter:350-397`) et `sync_delay` — **ni** plage,
**ni** polyphonie, **ni** notes discrètes, **ni** CC.
**Repro** : un clavier physique routé vers un instrument mécanique 4 voix / 2 octaves peut
lui envoyer des accords de 10 notes hors plage, non bridés.
**Reco** : partager la logique d'enforcement de `PlaybackScheduler` avec le route-through.

### P2-4 · `supported_ccs` jamais filtré à la lecture
Lu seulement pour le *scoring* de compatibilité (`InstrumentMatcher.scoreCCSupport:135-145`)
et l'affichage. `PlaybackScheduler._dispatchToDevice` transmet tout CONTROLLER sauf CC20/21
(gardés par `cc_enabled`, pas `supported_ccs`) — `PlaybackScheduler.js:1045-1056`. Idem
en live.
**Repro** : instrument `supported_ccs=[7,10]`, le fichier envoie CC1/CC11/CC64 → tous
transmis ; un firmware qui réaffecte un CC « non supporté » se dérègle.
**Reco** : filtrer les CC non déclarés (option, car parfois volontairement permissif).

### P2-5 · `octave_mode`/`scale_root` : moteur aveugle, enforcement délégué au frontend
Le pipeline de lecture **ignore `octave_mode`** (commentaires explicites
`CapabilityResolver.js:94`, `PlaybackScheduler.js:1006`, et surtout `ISMSave.js:283-289`).
L'enforcement de gamme repose entièrement sur la **matérialisation frontend** au save :
`ISMSave._materializeOctave` → `InstrumentSettingsModal.computePlayableNotes` bake le
sous-ensemble en `selected_notes` discrets (`ISMSave.js:290-346`), que le backend applique
via `_snapToSelected`. Tout writer **non-UI** (éditeur auto-assign
`update_instrument_capabilities`, API directe, création d'instrument virtuel, **futur
descripteur v2**) qui pose `octave_mode` sans matérialiser → le backend joue toutes les
notes chromatiques de la plage.
**Repro** : pad pentatonique C en mode `range` via un chemin non-UI, entrée F# →
sortie F# (hors gamme) au lieu de E/G.
**Reco** : porter le snapping de gamme dans le moteur (à partir de `octave_mode`+`scale_root`),
pour que la capacité soit appliquée indépendamment du frontend.

### P2-6 · Validateur de capacités jamais appelé sur les chemins d'écriture
`InstrumentCapabilitiesValidator.validateInstrument()` n'est invoqué par **aucun** chemin
d'écriture ; seul `_validateHandsConfig` l'est (`InstrumentSettingsCommands.js:35-36`). Les
writers `instrument_update_capabilities`, `instrument_save_all`, `instrument_create_virtual`,
`instrument_add_to_device`, `update_instrument_capabilities` ne le passent pas. Combiné à
l'absence de schéma d'enveloppe (P1-5), la validation ne tient qu'aux gardes impératives
partielles.
**Reco** : appeler `validateInstrument` dans les handlers d'écriture, ou ajouter les schémas.

### P2-7 · Colonnes de capacités par voix ignorées par le moteur
`instrument_voices` (note_range/selected_notes/octave_mode/min_note_* par voix) a un CRUD
complet, mais `listByInstrument` n'est appelé que par le câblage des commandes de voix
(`InstrumentDatabase.js:215`) — **aucun** chemin de lecture playback/adaptation/routing ne
lit les colonnes par voix ; le moteur ne lit que la ligne primaire `instruments_latency`
(`AutoAssigner._buildInstrumentList:252-278`). `voices_share_notes` n'est résolu qu'au
frontend (`ISMSave.js`, `InstrumentSettingsModal.computePlayableNotes`). Des lignes de voix
peuvent donc être écrites+validées puis silencieusement ignorées.
**Reco** : soit consommer les voix au backend, soit documenter que c'est frontend-only
(roadmap voix Phase 8).

### P2-8 · Les cordes ne bornent pas le flux de notes audible
`tuning`/`num_frets`/`is_fretless` ne façonnent que les **CC de tablature**
(`TablatureConverter.js`), une étape optionnelle. Une note au-dessus de la dernière frette
est émise `unplayable` mais **la noteOn part quand même à sa hauteur d'origine**
(`TablatureConverter.js:302,462`). `capo_fret` n'est jamais appliqué (support retiré,
`TablatureConverter.js:20,138`).
**Reco** : clarifier le contrat (les cordes sont-elles censées borner l'audible ?), sinon
documenter que seule la tablature en dépend.

### P2-9 · Aucun timeout/retry sur la reconnaissance ; `comm_timeout` inerte
`sendIdentityRequest` est fire-and-forget. `comm_timeout` est stocké (défaut 5000) mais
**jamais lu** dans `src/midi`. Les appareils qui ne répondent pas (DIN-IN seul, non-GMB)
ne persistent rien ; les appareils input-only *lèvent* à la requête (`DeviceManager.js:791`).
**Reco** : implémenter timeout + retries (spec §3) et lire `comm_timeout`.

---

## P3 — Correction fine / mineur

- **`min_note_interval` par-hauteur, pas par-mécanisme** — clé `device:channel:note`
  (`PlaybackScheduler.js:382-393`) : deux hauteurs différentes en succession rapide ne sont
  jamais bridées. Sous-contraint pour un instrument à striker unique partagé.
- **Stratégie de drop polyphonique runtime ≠ offline** — runtime jette la **dernière**
  noteOn (`_shouldGateNote:398-407`) ; offline garde grave+aigu et jette les voix internes
  (`MidiTransposer.reducePolyphony:167-178`). Même fichier, notes tombées différentes en
  live vs baked.
- **Collisions de repli de plage silencieuses au runtime** — `_foldIntoRange:329-342` peut
  mapper deux hauteurs sur la même note si la plage < 1 octave ; l'avertissement
  `compressionCollisions` n'existe qu'offline (`MidiTransposer.compressChannel:437-452`).
- **`selected_notes` non recoupé avec `note_range` ; repli avant snap** — le repli
  `[min,max]` (`:1001-1003`) précède le snap (`:1008-1010`) ; si `selected_notes` sort de
  `[min,max]`, la note finale peut sortir de la plage déclarée.
- **`polyphony: result.polyphony || null`** (`InstrumentCapabilitiesDB.js:326`) coerce un 0
  stocké → désactive le gate au lieu de muter (inoffensif tant que la validation interdit 0).
- **Champs round-trippés sans consommateur** — `bagpipe_config`/`accordion_config`/
  `harmonica_config` (validés, persistés, jamais lus en playback), `capo_fret` (jamais
  appliqué).
- **Pas de garde DB sur `instrument_voices`** (aucune `CHECK` : `supported_ccs`/
  `selected_notes` sans `json_valid`, `note_selection_mode`/`octave_mode` sans enum) ;
  `descriptor_json` sans `json_valid` (`migrations/033`). Sûr aujourd'hui car un seul writer
  valide en amont.
- **Migrations 032/033 ne s'auto-enregistrent pas dans `schema_version`** — inoffensif
  (le runner `DatabaseLifecycle.runSingleMigration` insère automatiquement), mais incohérent
  avec les autres migrations.

---

## Enforcement effectif — carte des champs (lecture de fichier)

| Champ | Appliqué au runtime ? | Mécanisme |
|---|---|---|
| `note_range_min/max` | **oui** (hors drums, ch≠9) | repli octave dans `[min,max]` (`PlaybackScheduler:1001-1003`→`_foldIntoRange`) |
| `note_selection_mode`+`selected_notes` | **oui** (mode `discrete`) | snap plus proche (`_snapToSelected:303-314`) |
| `polyphony` | **oui** | gate noteOn au-delà du max (`_shouldGateNote:398-407`) |
| `min_note_interval` | oui (par hauteur) | drop re-strike même note trop rapide |
| `min_note_duration` | **oui** | report du noteOff (`_noteOffDeferMs`) |
| `sync_delay` | **oui** (playback+live+clock) | délai/avance borné ±MAX |
| `cc_enabled`+`cc_string/fret` | **oui** | CC20/21 filtrés + tablature |
| `tuning`/`frets` | **partiel** | CC de tablature seulement, pas l'audible |
| `supported_ccs` | **non** | scoring uniquement |
| `octave_mode`/`scale_root` | **non (moteur)** | matérialisé côté frontend en `selected_notes` |
| voix secondaires | **non (backend)** | résolu frontend uniquement |
| `capo_fret`, `*_config` | **non** | round-trip sans consommateur |

---

## Reste à faire pour la reconnaissance v2 (rappel §12 de la spec)

- **Requête auto à la connexion** (P2-1) — préalable à toute reconnaissance réelle.
- **Pipeline descripteur** : transfert bloc `0x10` + validateur JSON + diff des surcharges
  (§6) ; écoute bloc `0x11` / relecture 30 s ; base d'association `instance_id → config` ;
  fetch HTTP (`flags` bit 0).
- **`capabilities_source='descriptor'`** — élargir la `CHECK` (rebuild de table) ; en
  attendant, toute écriture de cette valeur échouerait (P1-5).
- **Consommation** : `descriptor_revision`/`descriptor_json` (migration `033`) lus par personne
  aujourd'hui ; lookahead depuis `timing.prepare`, `resources`, `voices`+contraintes de
  polyphonie non modélisés côté moteur.

---

## Méthode

Audit croisé sur trois agents parallèles (ingestion, stockage/validation, consommation),
findings recroisés et points sensibles revérifiés manuellement (bug d'affichage modal,
matérialisation `octave_mode` via `ISMSave`, absence de `instrument.schemas.js`). Toutes les
références sont en `fichier:ligne` sur l'état de la branche au 2026-08-05.
