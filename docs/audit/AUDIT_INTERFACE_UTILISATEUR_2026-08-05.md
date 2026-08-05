# Audit complet de l'interface utilisateur — 2026-08-05

> Portée : SPA frontend (`public/`) et son intégration avec le backend WebSocket.
> Objectif : valider que **toutes les parties sont fonctionnelles et bien intégrées**.
> Méthode : validation automatisée (lint/typecheck/tests/build) + analyse
> statique croisée des surfaces commandes/événements + audit manuel par domaine
> (7 revues ciblées : contrôleur principal, éditeur MIDI, auto-assign/routage,
> clavier/loop/playlist, éclairage, réglages/système, instruments/périphériques).

## TL;DR — Verdict

**L'interface existante est saine et bien intégrée.** Aucune action utilisateur
cassée n'a été trouvée : chaque commande émise par le frontend possède un
handler backend, aucun fichier JS n'est chargé à vide ou manquant, aucun bouton
de navigation n'est orphelin, et l'outillage (lint, typecheck, 2507 tests,
build) est **entièrement vert**.

Le principal constat n'est **pas** de l'UI cassée, mais l'**asymétrie inverse** :
un grand nombre de capacités backend (commandes WS enregistrées et
fonctionnelles) n'ont **aucune surface UI**. Sur **268 commandes** enregistrées,
**~84 n'apparaissent nulle part** dans le frontend. Certaines sont des
sous-systèmes legacy/parallèles (routes manuelles, latence, presets génériques,
sessions), d'autres sont des fonctionnalités réelles au câblage manquant
(seek/tempo/volume/transposition en lecture, administration système).

| Axe | État |
|---|---|
| Outillage (lint/typecheck/tests/build) | ✅ Vert |
| Intégration commandes UI → backend | ✅ 100 % des appels frontend ont un handler |
| Fichiers JS chargés / présents | ✅ 190/190, aucun mort, aucun include cassé |
| Navigation & ouverture des vues/modals | ✅ Toutes câblées et instanciées |
| i18n (28 langues) | ✅ Ensembles de clés identiques ; ⚠️ ~36 clés utilisées manquantes |
| Capacités backend sans UI | ⚠️ ~84 commandes non exposées |
| Modules orphelins (poids mort) | ⚠️ 3 fichiers + ~1000 lignes legacy inline |
| Événements diffusés sans consommateur | ⚠️ 5 confirmés |
| Gap fonctionnel vivant | ⚠️ 1 (identité SysEx affichée mais non persistée) |

---

## 1. Validation automatisée (outillage)

Environnement préparé avec `npm install --ignore-scripts` (modules natifs
`better-sqlite3`/`midi` absents — comportement attendu en conteneur).

| Commande | Résultat |
|---|---|
| `npm run typecheck` (`tsc --noEmit`) | ✅ exit 0 |
| `npm run lint` (ESLint) | ✅ 0 erreur, 202 warnings (tous `no-console` pré-existants dans les scripts + 2 `jest` non utilisé dans des tests) |
| `npm test` (Jest backend) | ✅ 89 suites / 1096 tests (10 suites dépendantes de SQLite auto-skippées, faute de binaire natif) |
| `npm run test:frontend` (Vitest) | ✅ 71 fichiers / 1411 tests |
| `npm run build` (Vite) | ✅ `dist/` auto-suffisant produit |

Note build : Vite émet ~190 avertissements « can't be bundled without
type="module" » — **attendu et documenté** dans `vite.config.js` : les scripts
classiques sont copiés verbatim, pas bundlés. Pas un défaut.

---

## 2. Intégration commandes frontend ↔ backend

Mécanique : le frontend émet `apiClient.sendCommand('nom', data)` (+ 2 wrappers
dynamiques : le générique `api.sendCommand(variable)` à `index.html:13209`, et
`LightingHelpersMixin.sendCommand(command,data)`). Le backend enregistre via
`registry.register('nom', handler)`.

### ✅ Sens UI → backend : intègre
**Chaque littéral de commande émis par le frontend possède un handler backend
correspondant.** Aucune action UI ne cible une commande inexistante (0 sur 172
littéraux distincts). C'est le résultat le plus important pour la
« fonctionnalité » : rien de ce que l'utilisateur peut déclencher n'échoue faute
de handler.

### ⚠️ Sens backend → UI : large surface non exposée
**268 commandes enregistrées ; ~84 n'apparaissent nulle part dans `public/`.**
Réparties par famille :

| Famille | Non exposées | Nature |
|---|---|---|
| `route_*` (routes manuelles) | 10 | Sous-système legacy CRUD in-memory sur `MidiRouter`, **distinct** de l'auto-assignation. Aucune UI. |
| `playback_*` (temps réel + routage) | 10 | seek, set_tempo, set_volume, transpose, set_loop, *_channel_routing, set_disconnect_policy, validate_routing, get_channels |
| `system_*` (administration) | 9 | reboot, restart, shutdown, backup, restore, logs, clear_logs, status, info |
| `latency_*` | 8 | Implémentation **parallèle** de la latence, supplantée par `calibrate_*` (voir §6) |
| `instrument_*` (voice/light/type) | 8 | Voir §7 (agent instruments) |
| `session_*` | 6 | Sauvegarde/chargement de sessions : **aucune UI** |
| `file_*` | 6 | duplicate, export, move, search, routing_status, bake_cc |
| `midi_*` | 4 | all_notes_off, reset, categories_list, instruments_list (supplantés par `midi_panic` / listes GM codées en dur) |
| `preset_*` (génériques) | 6 | Snapshots routing/config : supplantés par `lighting_preset_*` et presets d'instruments |
| `virtual_*` | 3 | Voir §7 |
| `device_*` | 3 | Voir §7 |
| Autres | ~9 | tablature_delete, tablature_get_by_file, serial_list/status, bank_effects_list, filter_set/clear, channel_map, analyze_channel, validate_routing_feasibility, lighting_led_broadcast, lighting_scene_apply, playlist_clear, playlist_status |

**Lecture** : la majorité de ces endpoints ne sont **pas des bugs** — ce sont
des capacités serveur réelles (enregistrées, implémentées, souvent testées)
sans consommateur UI. Deux catégories :

1. **Sous-systèmes legacy/parallèles à documenter comme différés ou à retirer** :
   `route_*`, `latency_*` (doublon de `calibrate_*`), `preset_*` génériques,
   `serial_list/status`, `bank_effects_list`, `midi_reset/all_notes_off`.
2. **Fonctionnalités réelles au câblage UI manquant** (candidates à exposer) :
   contrôles de lecture (seek/tempo/volume/transpose/loop), administration
   système (reboot/shutdown/backup/restore/logs), gestion de sessions,
   `validate_routing_feasibility` (bandeau d'avertissement prévu par sa
   docstring, jamais branché).

---

## 3. Intégration des événements (backend → UI, WebSocket)

Le backend diffuse via `wsServer.broadcast(event, data)` (25 événements
littéraux, optional-chaining inclus). Le frontend s'abonne via
`api.on('event', handler)`.

### ✅ Chaîne d'état de lecture : fonctionnelle
L'état de lecture autoritatif transite par `playback_status`
(`MidiPlayer.js:1884` → `index.html:7466`, met à jour les contrôles). La
position transite par `playback_position`. Fonctionne.

### ⚠️ Événements diffusés sans écouteur UI (broadcasts « morts »)

| Événement | Constat | Sévérité |
|---|---|---|
| `system_lag` | Le backend surveille le lag de l'event-loop et envoie des trames binaires ; `BackendAPIClient` les **décode** en event `system_lag` (`:62`), mais **aucun `api.on('system_lag')`** → le lag n'est jamais montré à l'utilisateur. | Moyenne |
| `midi_event` | Diffusé par `DeviceManager.js:970`, **aucun écouteur** (supplanté par `monitor_event`, lui écouté). Broadcast redondant sur un chemin proche du hot-path MIDI. | Basse |
| `playlist_waiting` | Diffusé (`PlaylistCommands`), **aucun écouteur** → l'état « en attente » d'une playlist n'est pas reflété dans l'UI. | Basse |
| `settings_applied` | Diffusé, **aucun écouteur** → pas de synchronisation multi-clients des réglages à la réception. | Basse |
| `device_connected` | Diffusé (`Application.js:461`), **aucun écouteur** (l'UI se rafraîchit via `device_list`). Redondant. | Basse |

### ⚠️ Écouteurs « secondaires » fragiles
`playback_started/stopped/paused/resumed` : le backend **ne les diffuse jamais**
au WS (ils sont seulement *loggés* dans `Application.js:484-494` ; paused/resumed
n'ont même pas de handler). Les écouteurs UI (`index.html:7509-7560`) sont
alimentés par des **ré-émissions locales** (contournement documenté à
`index.html:10169` : « le backend peut ne pas envoyer playback_started »). Ça
fonctionne via `playback_status`, mais le design est redondant et fragile
(certaines mises à jour, ex. `updateFileStateDots()`, ne se déclenchent que sur
les chemins de ré-émission locale). **Sévérité : basse-moyenne (dette).**

### ⚠️ `reconnect_exhausted` sans écouteur
`BackendAPIClient` émet `reconnect_exhausted` après 12 échecs de reconnexion,
explicitement « so the UI can surface a clear connection lost state and stop
spinners » — mais **aucun écouteur UI**. L'événement `disconnected` est bien
géré (`index.html:7457`), donc l'UI réagit aux coupures ; c'est l'état « abandon
après N tentatives » qui n'est pas matérialisé. **Sévérité : basse-moyenne.**

---

## 4. Navigation, bootstrap & fichiers

- **Bootstrap** : ~190 `<script>` classiques (globals `window.*`) + un
  contrôleur inline (~8000 lignes, `index.html:6205-14341`). Pas de routeur :
  la « Bibliothèque » est le corps de page, les autres vues sont des overlays
  ouverts par bouton. Toutes les classes cibles sont instanciées au boot
  (`index.html:14194-14219`).
- ✅ **190 fichiers JS sur disque = 190 chargés** : aucun fichier mort non
  référencé, aucun `<script src>` pointant vers un fichier absent.
- ✅ Tous les boutons de navigation (`openKeyboardBtn`, `instrumentsBtn`,
  `lightingBtn`, `playlistBtn`, `calibrationBtn`, `loopCreatorBtn`,
  `settingsModal`, MIDI editor) sont câblés à un handler existant.
- ✅ Connexion WS : `connected` / `disconnected` / `error` gérés
  (`index.html:7430/7457/7461`).
- **IDs dupliqués** : les rares doublons détectés sont des **faux positifs**
  (placeholders de template `${fileId}`, boutons `confirmOkBtn/CancelBtn`
  recréés dynamiquement, `macAddress` en ternaire conditionnel input/hidden).
  Aucun vrai conflit d'ID statique.

---

## 5. i18n (28 langues) & accessibilité

### ✅ Cohérence des locales : excellente
Les **28 fichiers de locale** (`public/locales/`) ont **exactement le même
ensemble de 2812 clés** — vérifié par comparaison d'ensembles (pas seulement de
comptes) contre `en.json`. Aucune langue n'a de clé manquante ou en trop par
rapport à la référence.

### ⚠️ ~36 clés utilisées dans le code mais absentes des locales
`i18n.t()` renvoie la **clé brute** (+ `console.warn`) quand la clé manque dans
la locale active **et** le fallback français (`I18n.js:209-214`). ~36 clés
statiques référencées dans le code sont absentes de **toutes** les locales et
s'afficheront donc en texte brut là où elles sont atteintes. Exemples :
`common.undo`, `common.redo`, `common.pleaseWait`, `handsPreview.simulating`,
`handsPreview.transportHint`, toute la barre de transport de l'éditeur de mains
clavier (`keyboardHandEditor.play/pause/stop/mute/timeZoom/pitchZoom/nextProblem/
prevProblem/...`), plusieurs `instrumentSettings.errorNote*`,
`loopEditor.confirmDiscardTitle`, `keyboard.handMoveLeft/Right`,
`bluetooth.scanFailed`, `stringInstrument.sliderEnabled`. **Sévérité : basse**
(correctif simple : ajouter les clés). Liste exhaustive en annexe.

### ✅ Accessibilité : correcte
- `<html lang>` mis à jour dynamiquement au changement de locale
  (`I18n.js:141`) ; `dir="ltr"` acceptable (aucune langue RTL supportée).
- 82 attributs `aria-*`, 32 `role=`, feuille `accessibility-focus.css` chargée,
  aucun `<img>` (icônes en emoji/CSS/SVG → pas de problème de `alt`).
- ⚠️ Mineur : 15/72 boutons seulement ont un `aria-label` explicite ; les
  boutons purement iconographiques gagneraient à en avoir un.

---

## 6. Découvrabilité & doublons notables

- **Boutons masqués par défaut** : `showLightingButton=false` et
  `showCalibrationButton=false` (`SettingsModal.js:94-95`). Les pages Éclairage
  et Calibration sont **fonctionnelles mais non découvrables** tant que
  l'utilisateur ne les active pas dans Réglages. Choix délibéré (fonctions
  avancées), mais à connaître. Les autres boutons (playlist, keyboard,
  instruments, loop) sont visibles par défaut.
- **Double implémentation de la latence** : `calibrate_*` + `tuner_*` (utilisés
  par `CalibrationModal`/`TunerModal`, persistance via `instrument_update_settings`)
  vs `latency_*` (8 commandes CRUD/mesure **jamais branchées**). Forte odeur de
  code : un système complet écrit puis contourné.
- **`file_move` purement client** : le déplacement de fichiers vers des dossiers
  (`moveFileToFolder`, `index.html:9349`) manipule un objet `folderStructure` en
  `localStorage` et **n'appelle jamais** la commande backend `file_move`.
  Conséquence : l'organisation en dossiers n'est **pas persistée côté serveur**
  → désynchronisation possible entre appareils/rechargements. **Sévérité : moyenne.**

---

## 7. Instruments / périphériques

C'est le domaine où se concentrent les constats les plus importants — non pas de
l'UI cassée visible par l'utilisateur, mais **un gros bloc de code legacy mort
inline dans `index.html`** et **un gap de persistance SysEx**.

### ⚠️ [MOYENNE] Identité SysEx affichée mais non persistée
Dans la modale **vivante** `DeviceSettingsModal`, `_handleSysExIdentity`
(`:247-265`) **affiche** l'identité reçue (« ✅ Identité reçue ») mais
n'appelle **jamais** `device_save_sysex_identity`. Le backend sépare
explicitement `sysex_identity_request` (émettre la requête MIDI) de
`device_save_sysex_identity` (persister). Sauf auto-persistance côté backend,
**l'identité est montrée puis perdue à la fermeture** — le message de succès est
trompeur. `device_save_sysex_identity` n'a aucun appelant vivant.

### 🗑️ [HAUTE — code mort, pas de casse visible] Modale d'instrument legacy inline
`index.html:11150` `function showInstrumentSettings(device)` + son handler de
sauvegarde (~`12063-12200`) + `switchInstrumentTab`/`deleteInstrumentTab`/
`currentDeviceSettings` forment une **modale de réglages d'instrument legacy
d'environ 1000 lignes**, doublon complet de la classe vivante
`InstrumentSettingsModal.js`. Son **seul** point d'entrée est
`settingsBtn.onclick` (`index.html:9536`), lui-même situé dans la branche de
rendu de `#deviceList` — **elle-même morte** (voir ci-dessous). Ces fonctions
sont bien *définies* (donc les `onclick` inline résolvent), mais **inatteignables**.

### 🗑️ [HAUTE — code mort] Liste de périphériques inline `#deviceList`
`index.html:9408-9542` rend une liste de périphériques via
`document.getElementById('deviceList')`, mais **aucun élément `id="deviceList"`
n'existe** dans le DOM ; tout le rendu est gardé par `if (deviceList)` et ne
s'exécute donc jamais. La liste vivante est fournie par
`InstrumentManagementPage`. `requestIdentity()` (`index.html:11947`) n'est
elle non plus **jamais appelée** (→ `device_identity_request` inline mort).

> Ces blocs ne causent **aucune régression visible** (une implémentation vivante
> les remplace intégralement) mais alourdissent `index.html` de ~1000+ lignes et
> constituent un piège de maintenance. Candidats à suppression.

### Adjudication commandes (résumé)
- **WIRED** : `device_get_settings`, `device_update_settings`,
  `instrument_voice_list`, `instrument_create_virtual`,
  `virtual_instrument_toggle`, `instrument_list_by_device`, tous les
  `calibrate_*` (5), tous les `tuner_*` (3), tous les `string_instrument_*` (4),
  `instrument_list_registered`.
- **DYNAMIQUE** : `instrument_list_connected`/`instrument_list_registered` via
  le ternaire `index.html:13207` (filtre « Playable on instruments »).
- **NON-CÂBLÉE** (capacités backend sans appelant vivant) :
  `device_enable`, `device_info`, `device_set_properties`,
  `instrument_voice_{create,update,delete,replace}` (CRUD complet inutilisé — le
  front persiste les voix via le bundle `instrument_save_all.voices`),
  `instrument_type_detect`, `instrument_types_list`,
  `virtual_{create,delete,list}` (ancien système « brut » remplacé par
  `instrument_create_virtual` + `instrument_delete`).
- **MORTE** : `device_identity_request` (inline `requestIdentity` jamais
  appelée ; l'alias vivant `sysex_identity_request` couvre le besoin),
  `device_save_sysex_identity` (aucun appelant vivant — voir gap SysEx).

### Modals & sauvegardes (chemins vivants)
| Modal | Atteignable | Sauvegarde |
|---|---|---|
| `InstrumentSettingsModal` | ✅ `showInstrumentSettings`/`editInstrument` | `instrument_save_all` |
| `DeviceSettingsModal` | ✅ `open-device-settings` | `device_update_settings` (⚠️ SysEx non persistée) |
| `InstrumentCapabilitiesModal` | ✅ `completeInstrument` | `update_instrument_capabilities` + `string_instrument_create` |
| `CalibrationModal` | ✅ `#calibrationBtn` (masqué par défaut) | `instrument_update_settings` |
| `TunerModal` | ✅ imbriquée dans Calibration | monitor start/stop |

Aucun fichier `.js` orphelin dans ce domaine — le code mort est **inline**.
Note : `update_instrument_capabilities`/`get_instrument_defaults`/
`validate_instrument_capabilities` sont enregistrées dans
`PlaybackAssignmentCommands.js` (pas `InstrumentSettingsCommands.js`) — les
appels des modales sont donc valides (pas de bug de nom).

---

## 8. Modules orphelins (poids mort chargé)

| Fichier | Constat |
|---|---|
| `public/js/features/settings/SettingsModalContent.js` | **Mort auto-documenté** : le fichier déclare lui-même être un « dead legacy module … no longer mixed in or referenced anywhere ». Chargé (`index.html:6190`) uniquement pour exposer un `window.SettingsModalContent = {}` vide. |
| `public/js/features/midi-editor/MidiEditorToolbar.js` | `class MidiEditorToolbar` **jamais instanciée**. Toutes ses méthodes ont un doublon vivant et câblé (`MidiEditorEditActions`, `MidiEditorViewport`, `MidiEditorChannelOps`). Chargé mort (`index.html:6029`). Contient un bug latent (`this.editActions` non défini) jamais exécuté. |
| `public/js/features/piano-roll/PianoRollRenderer.js` | `class PianoRollRenderer` **jamais référencée** ; supplantée par `CanvasPianoRollRenderer` (seule utilisée). Chargée morte (`index.html:6025`). |

Retirer ces 3 scripts (et fichiers) allègerait le chargement sans risque.

**Code mort inline (dans `index.html`, pas des fichiers)** — voir §7 :
- Modale d'instrument legacy `showInstrumentSettings` (~1000 lignes, `~11150-12200`).
- Liste de périphériques legacy `#deviceList` (`9408-9542`) + `requestIdentity`
  (`11947`) — élément DOM inexistant, branche jamais exécutée.

Ces blocs sont entièrement supplantés par `InstrumentManagementPage` /
`InstrumentSettingsModal` et peuvent être supprimés.

---

## 9. Recommandations priorisées

### Priorité haute
- **Aucune régression bloquante.** L'UI existante fonctionne.

### Priorité moyenne (fonctionnalités attendues au câblage manquant)
1. **Persistance de l'identité SysEx** : dans `DeviceSettingsModal._handleSysExIdentity`,
   appeler `device_save_sysex_identity` après réception — sinon retirer le message
   « ✅ Identité reçue » trompeur (seul gap *fonctionnel vivant* de l'audit).
2. **Contrôles de lecture temps réel** : exposer seek/tempo/volume/transpose/loop
   dans la barre de transport principale (backend prêt :
   `PlaybackControlCommands.js:166-235`).
3. **Persistance des dossiers de fichiers** : brancher `moveFileToFolder` sur la
   commande `file_move` au lieu du seul `localStorage`.
4. **`system_lag`** : ajouter un écouteur + indicateur visuel (le backend fait
   déjà tout le travail de détection et d'envoi).
5. **`reconnect_exhausted`** : matérialiser l'état « connexion perdue » et
   stopper les spinners après abandon.
6. **`validate_routing_feasibility`** : brancher le bandeau d'avertissement
   prévu, ou documenter le report.

### Priorité basse (hygiène / dette)
6. Ajouter les **~36 clés i18n** manquantes (annexe).
7. Retirer les **3 modules orphelins** + le **code legacy inline** de `index.html`
   (modale d'instrument ~1000 lignes + liste `#deviceList` morte, §7/§8).
8. Décider du sort des **sous-systèmes non branchés** (`route_*`, `latency_*`,
   `preset_*` génériques, `session_*`, admin `system_*`) : exposer ou retirer,
   pour clarifier la surface d'API.
9. Nettoyer les **broadcasts redondants** (`midi_event`, `device_connected`,
   `settings_applied`, `playlist_waiting`) ou leur ajouter un consommateur.
10. `aria-label` sur les boutons purement iconographiques.

---

## Annexe A — Divergences avec la documentation
- `CLAUDE.md` et `docs/ARCHITECTURE.md` mentionnent un `AppRegistry` dans
  `public/js/core/` : **absent** du dépôt (seuls `BaseView`, `BaseModal`,
  `EventBus` existent). Doc à corriger.

## Annexe B — Clés i18n manquantes (à ajouter aux 28 locales)
`autoAssign.hidden`, `bluetooth.scanFailed`, `common.pleaseWait`, `common.redo`,
`common.undo`, `handPositionEditor.openButtonFull`, `handsPreview.simulating`,
`handsPreview.transportHint`, `instrumentSettings.errorNoteMax`,
`instrumentSettings.errorNoteMin`, `instrumentSettings.errorNoteMinMax`,
`instrumentSettings.handsNumFingersAlignedHint`,
`instrumentSettings.handsPreviewLabel`, `instrumentSettings.kitUnavailable`,
`instrumentSettings.selectCategory`, `instruments.list`, `keyboard.handMoveLeft`,
`keyboard.handMoveRight`, `keyboard.listViewLockedFingers`,
`keyboardHandEditor.kbZoomIn`, `keyboardHandEditor.kbZoomOut`,
`keyboardHandEditor.mute`, `keyboardHandEditor.nextProblem`,
`keyboardHandEditor.noAudio`, `keyboardHandEditor.pause`,
`keyboardHandEditor.pitchZoom`, `keyboardHandEditor.play`,
`keyboardHandEditor.playFailed`, `keyboardHandEditor.prevProblem`,
`keyboardHandEditor.stop`, `keyboardHandEditor.timeZoom`, `loopCreator.instrument`,
`loopEditor.chooseInstrumentFirst`, `loopEditor.confirmDiscardTitle`,
`settings.groups.keyboardGpio`, `stringInstrument.sliderEnabled`.

_(Note : les préfixes dynamiques comme `drumNotes.`, `lighting.lightEffect.`,
`autoAssign.type_` sont des clés construites à l'exécution — non incluses.)_
