# Audit complet UI ↔ backend — liaison des données par champ — 2026-08-06

> **Portée** : tous les modals/pages accessibles à un utilisateur dans la SPA
> (`public/`) et leur intégration avec le backend WebSocket.
> **Objectif** : vérifier que **toutes les données affichées/saisies sont réellement
> reliées au backend** et que chaque action fonctionne comme prévu.
> **Méthode** : cartographie complète des surfaces (272 commandes backend, 147 noms
> de commandes émis par le frontend, événements WS), puis **8 revues parallèles**
> traçant chaque interaction **des deux côtés** (payload envoyé ↔ champs lus par le
> handler + schéma ; réponse renvoyée ↔ champs consommés par l'UI), plus validation
> automatisée (tests frontend).

## Relation avec l'audit du 2026-08-05

L'audit précédent (`AUDIT_INTERFACE_UTILISATEUR_2026-08-05.md`) a validé la
**surface** : « 100 % des appels frontend ont un handler », aucun fichier JS mort,
navigation câblée. Ce constat est **reconfirmé ici**. Cet audit-ci va **un cran plus
loin** : il vérifie la **liaison au niveau des champs** (noms de propriétés dans les
payloads et les réponses, y compris les trames binaires temps réel). C'est
précisément à ce niveau que se trouvent les défauts ci-dessous — invisibles à une
analyse de surface « la commande existe-t-elle ? ».

---

## TL;DR — Verdict

La structure est saine : **les 147 noms de commandes émis par le frontend
correspondent tous à un handler enregistré**, et la suite de tests frontend est
**verte (71 fichiers, 1411 tests)**. Mais la vérification champ-par-champ révèle
**13 défauts de liaison confirmés**, dont **3 rendent une fonctionnalité
entièrement non opérationnelle** (accordeur, VU-mètre de calibration, rechargement
des positions de main).

| Sévérité | Nb | Effet |
|---|---|---|
| 🔴 Haute | 3 | Fonctionnalité affichée mais **non fonctionnelle** (données jamais reliées) |
| 🟠 Moyenne | 6 | Action/donnée perdue ou dégradée (persistance, doublon, contrôle inopérant) |
| 🟡 Basse | 4 | Impact masqué / cas limite / code mort sans effet visible |

Zones **entièrement saines** (vérifiées des deux côtés, aucun défaut) : Réglages &
Système, clavier jouable (note/CC/pitchbend), Éclairage (devices/règles/presets/
groupes/effets), scan BLE/Réseau/Série, Loop manager + arrangeur + éditeur,
PlaylistEditor, aller-retour fichier/routage/tablature de l'éditeur MIDI,
capacités d'instrument & config cordes, persistance des réglages device,
bibliothèque de fichiers / upload / dialogues (dossier, renommer, confirmation).

---

## 🔴 Défauts de sévérité HAUTE

### H1 — Accordeur (TunerModal) : n'affiche jamais de note
- **Fichier** : `public/js/features/TunerModal.js:623-625`
- **Symptôme** : `_handlePitchEvent` lit `payload.freq` et `payload.confidence`, puis
  garde `if (freq <= 0 || confidence < 0.5) return;`. Or l'événement `tuner:pitch`
  arrive en **trame binaire** décodée en `{ freqHz, cents, noteMidi }`
  (`BackendAPIClient.js:45-53`, `shared/BinaryFrameCodec.js:243-251`). `freq` et
  `confidence` sont donc toujours `undefined` → le garde renvoie à **chaque** trame.
- **Aggravation côté émission** : `encodeByEvent` lit `payload.freqHz ?? payload.frequency`
  (`BinaryFrameCodec.js:158`) alors que le calibrateur émet `{ freq, confidence, rms }`
  (`DelayCalibrator`), donc la fréquence transmise est **0** de toute façon.
- **Confirmé** : le binaire est actif par défaut (`WsOutputQueue.js:103`
  `enableBinary = true`, **aucun** override dans `WebSocketServer.js:83` ; l'événement
  passe bien par `encodeByEvent`, `WsOutputQueue.js:261`).
- **Impact utilisateur** : l'accordeur reste bloqué sur « — » en permanence — sa seule
  fonction est inopérante.
- **Correctif** : aligner les noms de champs de bout en bout (`freqHz`/`cents`/`noteMidi`)
  dans `DelayCalibrator` (émission) **et** `TunerModal` (lecture).

### H2 — Calibration (CalibrationModal) : VU-mètre / RMS figés à 0
- **Fichier** : `public/js/features/CalibrationModal.js:270-273`
- **Symptôme** : `_onAudioLevel` lit `data.rms` / `data.peak`, mais
  `calibration:audio_level` est décodé en `{ levelDb, peakDb }`
  (`BackendAPIClient.js:54-61`, `BinaryFrameCodec.js:252-259`). `_currentRMS` reste 0,
  la barre reste à 0 % et le libellé affiche « 0.000 » en dur, sans jamais franchir le
  seuil.
- **Aggravation côté émission** : `encodeByEvent` lit `payload.levelDb ?? payload.level`
  (`BinaryFrameCodec.js:164`) alors que le calibrateur émet `{ rms, peak }` → le niveau
  transmis est 0.
- **Impact utilisateur** : le retour audio temps réel affiche une valeur « 0.000 »
  crédible mais fausse. La **mesure de délai elle-même** (calcul serveur) n'est pas
  affectée — seul le VU-mètre live est mort.
- **Correctif** : mêmes champs des deux côtés (`levelDb`/`peakDb`).

### H3 — Routage/auto-assign : les positions de main enregistrées ne se rechargent jamais
- **Fichier** : `public/js/features/auto-assign/RoutingSummaryPage.js:296-304` (+ lecteur `:1411`)
- **Symptôme** : l'enregistrement fonctionne (`routing_save_hand_overrides` → SQL
  UPDATE) et `get_file_routings` **renvoie** bien `routings[].hand_position_overrides`.
  Mais en reconstruisant `selectedAssignments`, la page ne recopie que
  `instrumentId/deviceId/instrumentName/score/transposition` et **omet
  `hand_position_overrides`**. L'unique lecteur `_extractInitialOverrides` (`:1411`)
  cherche `handPositionOverrides`/`hand_position_overrides`, un champ **jamais
  positionné** → `initialOverrides` est toujours `null`.
- **Impact utilisateur** : après un rechargement, l'éditeur de positions de main et le
  panneau d'aperçu s'ouvrent **toujours vides**. L'utilisateur qui a édité et
  enregistré (toast de succès) retrouve son travail « disparu » à la réouverture —
  alors qu'il est toujours en base et toujours appliqué à la lecture.
- **Correctif** : recopier `r.hand_position_overrides` dans l'assignment (`:296-304`).

---

## 🟠 Défauts de sévérité MOYENNE

### M1 — DeviceSettingsModal : bouton « Demander l'identité via SysEx » inopérant
- **Fichier** : `public/js/features/DeviceSettingsModal.js:231`
- **Symptôme** : envoie `{ deviceId }`, mais le handler attend `deviceName`
  (`DeviceCommands.js:202` → `DeviceManager` fait `this.outputs.get(deviceName)` →
  `Output device not found: undefined`). De plus l'appel n'est pas `await`é
  (fire-and-forget), donc le rejet est silencieux et le bouton « tourne » 5 s puis se
  réinitialise. Appelant correct pour comparaison : `index.html:12129` envoie
  `{ deviceName: deviceId, deviceId: 0x7F }`.
- **Impact** : le clic n'émet jamais de requête d'identité. *Atténuation* : le listener
  d'affichage `device_identity` fonctionne, donc une réponse spontanée d'un appareil
  peut quand même remplir le panneau (cf. l'auto-persistance notée dans l'audit
  précédent). Le **bouton explicite**, lui, est bien cassé.
- **Correctif** : envoyer `{ deviceName: this.deviceId }` (+ `await`).

### M2 — InstrumentSettingsModal : le SoundFont personnalisé (`custom_sf2_id`) est perdu à l'enregistrement
- **Fichiers** : `public/js/features/instrument-settings/ISMSave.js:419,471` ↔ `src/api/commands/InstrumentSettingsCommands.js:720-735`
- **Symptôme** : le modal n'enregistre **que** via `instrument_save_all` (`ISMSave.js:471`),
  qui **n'inclut pas** `custom_sf2_id` dans l'écriture des settings (la docstring
  `:200` le confirme : « only `instrument_update_settings` accepts it »). La colonne
  existe (`InstrumentSettingsDB.js:88`) et `instrument_update_settings` la persiste bien
  (`:335`), mais ce chemin n'est jamais emprunté par le modal.
- **Impact** : l'utilisateur choisit/upload un SF2 dédié dans l'onglet Avancé, le voit en
  aperçu, enregistre → le choix est **perdu au rechargement**.
- **Correctif** : ajouter `custom_sf2_id` au payload/écriture de `instrument_save_all`.

### M3 — InstrumentSettingsModal : bascule « Pitch Bend » sans aucun backend
- **Fichiers** : `public/js/features/instrument-settings/ISMSections.js:1073-1084`,
  `ISMSave.js:443`
- **Symptôme** : la case « Pitch Bend » (`#pitchBendEnabled`) est envoyée à
  l'enregistrement mais `instrument_save_all` ne la transmet nulle part, et la chaîne
  `pitch_bend` **n'existe dans aucun fichier `src/` ni aucune migration** (grep = 0). Il
  n'y a ni colonne ni handler.
- **Impact** : basculer « Pitch Bend » ne fait rien et n'est jamais persisté ; la molette
  de pitch-bend du clavier virtuel, qui dépend de `caps.pitch_bend_enabled`
  (`KeyboardControls.js:179`, `KeyboardSlider.js:279`), ne peut donc jamais être activée
  via l'UI.
- **Correctif** : ajouter le champ (colonne + persistance) côté backend, ou retirer la
  case si la capacité n'est pas prévue.

### M4 — LightingControlPage : les scènes enregistrées sont inapplicables
- **Fichiers** : `public/js/features/LightingControlPage.js:1009,1038`,
  `public/js/features/lighting/LightingPresetsUI.js:13-24` ↔ `src/api/commands/LightingCommands.js:285-298,676-707,844`
- **Symptôme** : `lighting_scene_save` stocke la scène dans la table des **presets** avec
  un `rules_snapshot` **objet**. Les scènes apparaissent dans la même liste de presets,
  chacune avec un bouton « Charger » → `lighting_preset_load`, qui **rejette
  explicitement** les snapshots objet (`if (!Array.isArray(...)) throw ... « Use
  scene_apply instead »`). `lighting_scene_apply` **est** enregistré mais **n'est jamais
  appelé** par le frontend (grep `scene_apply`/`applyScene` = 0).
- **Impact** : les scènes sont « write-only » : enregistrables et supprimables, jamais
  applicables ; cliquer « Charger » produit un toast d'erreur.
- **Correctif** : router le « Charger » d'une scène vers `lighting_scene_apply`, ou
  distinguer scènes et presets dans l'UI.

### M5 — PlaylistPage : renommer crée une playlist fantôme
- **Fichier** : `public/js/features/PlaylistPage.js:690,700`
- **Symptôme** : `_renamePlaylist` appelle `playlist_create` **deux fois** — une première
  fois (`:690`) dont le résultat est jeté, puis une seconde (`:700`) qui reçoit les items
  copiés. (Pas de commande `playlist_rename` : le renommage est fait par
  supprime+recrée.)
- **Impact** : chaque renommage laisse une **playlist vide en double** (même nom) en base
  et dans la liste ; la **description** est aussi perdue (le 2ᵉ appel n'envoie que
  `{ name }`).
- **Correctif** : supprimer le 1ᵉʳ `playlist_create` (`:690`) et passer `description` au
  second.

### M6 — RoutingSummaryPage : « Transposition OFF » contournée par un clamp backend
- **Fichiers** : `public/js/features/auto-assign/RoutingSummaryPage.js:3213-3216` ↔ `src/midi/playback/commands/PlaybackAnalysisCommands.js:124-128`
- **Symptôme** : désactiver la stratégie « Transposition » envoie
  `penalties.maxTranspositionOctaves = 0`, mais le backend clampe
  `Math.max(1, Math.min(6, ...))` → `0` devient `1`. Le backend ne lit jamais
  `routing.allowTransposition` directement.
- **Impact** : « pas de transposition » autorise quand même jusqu'à **1 octave** (12
  demi-tons) en auto-assignation ; le contrôle sous-livre silencieusement.
- **Correctif** : gérer explicitement l'état « OFF » (autoriser 0 octave, ou désactiver
  la transposition en amont du scoring).

---

## 🟡 Défauts de sévérité BASSE

### B1 — Barre de transport : 4 abonnements à des événements jamais diffusés
- **Fichier** : `public/index.html:7570,7582,7600,7612`
- **Détail** : abonnements à `playback_started`/`playback_stopped`/`playback_paused`/
  `playback_resumed`, que le backend ne diffuse jamais (seuls `playback_status` +
  `playback_position` binaire le sont ; `MidiPlayer.start/stop/pause/resume` appellent
  `broadcastStatus()`, la JSDoc `MidiPlayer.js:1228/1413` est périmée). État
  bouton/progression compensé par `playback_status`, piano-roll par des émissions
  locales — **seule exception** : la **pause** via l'en-tête ne notifie jamais le piano
  roll (aucune émission locale `playback:pause`).

### B2 — Raccourcis clavier du tableau de bord : garde de modal sur la mauvaise classe CSS
- **Fichier** : `public/index.html:12387`
- **Détail** : `isModalOpen` teste `.confirm-modal-overlay.show`, mais `showConfirm`/
  `showAlert` révèlent le modal avec `.visible` (`:6361,6443`). Résultat : pendant qu'un
  dialogue de confirmation/alerte est ouvert, les raccourcis fichiers ne sont pas
  supprimés (Espace→lecture, Suppr→confirmation imbriquée, Entrée→éditeur, F2→renommer,
  flèches→sélection, Échap→désélectionne aussi). La garde sœur `.folder-modal-overlay.show`
  est correcte. **Correctif** : tester `.confirm-modal-overlay.visible`.

### B3 — Éditeur MIDI : branche de réponse morte (optimisation neutralisée)
- **Fichier** : `public/js/features/midi-editor/MidiEditorSpecializedEditors.js:103-104`
- **Détail** : lit `createResp.instrument` depuis `string_instrument_create_from_preset`,
  qui ne renvoie que `{ success, id }` (`StringInstrumentCommands.js:233`). L'optimisation
  documentée « éviter un second lookup » ne s'active jamais ; masqué par un fallback qui
  fonctionne (`findStringInstrument`). Aucun blocage utilisateur.

### B4 — Bibliothèque de fichiers : 3 abonnements morts
- **Fichier** : `public/index.html:7721-7723`
- **Détail** : `api.on('file_uploaded'|'file_delete'|'file_write', …)` — ces noms ne sont
  émis que sur l'EventBus **interne** du backend, jamais diffusés en WS. Sans effet :
  `file_list_updated` (`:7720`) rafraîchit déjà la liste à chaque mutation. Code mort à
  retirer.

---

## Observations (non-défauts — dépendent de l'intention produit)

1. **~85 commandes backend enregistrées sans aucun appelant UI** (reconfirme l'audit
   précédent). Familles notables sans surface : `session_*` (6), `preset_*` (6),
   `latency_*` (8, distinctes des `calibrate_*`), `route_*` (10, API bas-niveau),
   maintenance système (`system_backup/restore/reboot/restart/shutdown/logs`).
   Probablement internes/API-only, mais aucun modal ne les expose.
2. **Faisabilité des positions de main recalculée côté client**
   (`HandPositionFeasibility.js`, `HandSimulationEngine.js`) : vraie simulation, non
   stubbée, mais réimplémentation parallèle. `validate_routing_feasibility` (backend) et
   les `handPositionWarnings` renvoyés par `apply_assignments` ne sont jamais consommés →
   **risque de divergence** avec le scoring serveur.
3. **`update_instrument_capabilities` renvoie toujours `success:true`** (les échecs par
   item ne sont pas remontés) ; la branche d'erreur du modal est inatteignable.
   `InstrumentManagementPage.completeInstrument/testInstrument` ne sont câblés à aucun
   bouton → `InstrumentCapabilitiesModal` est inatteignable depuis cette page.
4. **`playlist_waiting`** (décompte d'inter-piste) est diffusé mais **aucun listener** ne
   l'affiche (cosmétique).
5. **Dossiers de la bibliothèque = localStorage uniquement** (par conception) ;
   `file_move/duplicate/export/save_as` non appelés depuis le tableau de bord.
6. **`system_update`** est protégé par token (`GMBOOP_API_TOKEN`) — par conception ; le
   chemin de lecture `system_check_update` n'est pas protégé, le statut s'affiche donc
   correctement.

---

## Méthodologie & limites

- **Traçage statique croisé des deux côtés** de chaque interaction (payload ↔ handler+
  schéma ; réponse ↔ consommation UI ; événements WS/binaire ↔ émission). Chaque défaut
  ci-dessus a été confirmé en lisant **les deux côtés**.
- **Tests** : suite frontend Vitest **verte (71 fichiers, 1411 tests)**. Les suites
  backend dépendantes de SQLite sont auto-ignorées sans le module natif `better-sqlite3`
  (cf. `CLAUDE.md`) ; non exécutées ici.
- **Pas de test runtime** des flux natifs (MIDI/ALSA/BLE) : indisponibles hors
  Raspberry Pi. Les défauts temps réel (H1/H2) ont été confirmés statiquement de bout en
  bout (émission → codec binaire → décodage → consommation).

## Correctifs

Ce document est un **audit** ; aucun correctif n'a été appliqué. Les 13 défauts sont
localisés (fichier:ligne) et un correctif est proposé pour chacun — implémentables sur
demande.
