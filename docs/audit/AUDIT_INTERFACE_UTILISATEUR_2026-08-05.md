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
| i18n (28 langues) | ✅ Ensembles de clés identiques ; ~36 clés manquantes **corrigées** |
| Capacités backend sans UI | ⚠️ ~84 commandes non exposées |
| Modules orphelins (poids mort) | ⚠️ 2 fichiers (retirés) ; branches mortes inline entrelacées (reportées) |
| Événements diffusés sans consommateur | ⚠️ 5 confirmés |
| Gap fonctionnel vivant | ✅ Aucun (identité SysEx auto-persistée côté backend — vérifié) |

---

## Correctifs appliqués sur cette branche

En complément de l'audit, quatre correctifs demandés ont été traités :

1. **Identité SysEx (Fix 1)** — **non nécessaire, vérifié** : le backend
   auto-persiste déjà l'identité à la réception (`DeviceManager.js:934-941`).
   Aucune modification ; rapport corrigé (§7).
2. **Contrôles de lecture temps réel (Fix 4)** — **appliqué** : barre de
   progression seekable + popover 🎛️ (tempo / volume / transposition) câblés aux
   commandes `playback_seek` / `playback_set_tempo` / `playback_set_volume` /
   `playback_transpose`. Smoke test navigateur (Chromium) OK, sans exception JS.
3. **Clés i18n manquantes (Fix 3)** — **appliqué** : 35 clés manquantes + 5 clés
   `ui.*` ajoutées aux 28 locales (invariant de parité préservé, test `audit-i18n`
   vert).
4. **Code legacy mort (Fix 2)** — **partiel** : 2 fichiers réellement orphelins
   supprimés (`SettingsModalContent.js`, `MidiEditorToolbar.js`). La « modale
   d'instrument legacy de ~1000 lignes » s'est révélée être des **branches mortes
   entrelacées dans des fonctions vivantes** (et non un bloc isolé) — sa
   suppression est **reportée** à un refactor délibéré (§7 rectifié). Correction :
   `PianoRollRenderer.js` **n'est pas** orphelin (classe de base vivante).

Validation post-correctifs : typecheck ✅, lint ✅ (0 erreur), 1096 tests backend
✅, 1411 tests frontend ✅, build ✅, smoke test navigateur ✅.

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

### ✅ [CORRIGÉ — non-problème] Identité SysEx
Une revue initiale a signalé que la modale vivante `DeviceSettingsModal`
(`_handleSysExIdentity`, `:247-265`) affiche l'identité reçue sans appeler
`device_save_sysex_identity`, laissant craindre une perte à la fermeture.
**Vérification faite, c'est un non-problème** : le backend **auto-persiste**
l'identité dès réception de l'Identity Reply, *avant* de diffuser
`device_identity` (`DeviceManager.js:934-941` :
`this.database.saveSysExIdentity(deviceName, 0, identityInfo)`). La commande
`device_save_sysex_identity` est donc un **endpoint de sauvegarde explicite
redondant** (sans appelant vivant), pas un chemin de persistance manquant.
_Nuance mineure éventuelle_ : l'auto-save utilise `deviceName` + canal `0`, là
où la commande explicite prendrait `deviceId` + `data.channel` — à vérifier si
la clé de stockage doit être un `deviceId` ; hors périmètre de cet audit UI.

### ⚠️ [RECTIFIÉ] Code legacy inline — branches mortes imbriquées, PAS un bloc propre
> Une revue initiale a décrit ~1000 lignes de « modale d'instrument legacy
> morte » supprimables d'un bloc. **Vérification approfondie : cette
> description est inexacte et la suppression en masse a été écartée comme trop
> risquée pour un gain fonctionnel nul.** Le code réputé mort est en réalité
> **entrelacé avec du code vivant** :
>
> - `window.showInstrumentSettings` (`index.html:10910`) est un **proxy vivant
>   de 4 lignes** vers le composant moderne `InstrumentSettingsModal` — c'est
>   le point d'entrée réellement utilisé. Il **coexiste** (homonymie) avec un
>   `async function showInstrumentSettings` legacy (~`11329`) qui, lui, n'est
>   appelé que depuis une branche morte.
> - `loadDevices()` (`index.html:9471`) est appelé depuis **8 sites vivants**
>   (7498, 10022, 10031, 12363, 12927, 12936, 14126). C'est une fonction
>   **vivante** dont seule la *branche de rendu* `#deviceList` est morte
>   (`if (deviceList)` toujours faux — l'élément n'existe pas).
> - Le handler `api.on('device_identity')` (~`7679`) **logue en direct** chaque
>   identité reçue ; seule sa branche de mise à jour de modale (gardée par
>   `currentDeviceSettings`, jamais assignée) est morte.
> - Les helpers (`switchInstrumentTab`, `saveInstrumentSettings`,
>   `navigatePiano`, `clearPianoRange`, l'état `currentDeviceSettings` /
>   `_instrumentTabs`) sont **interspersés** et partagent de l'état déclaré
>   hors du « bloc ».
>
> **Conclusion** : il ne s'agit pas d'un bloc mort isolé mais de **branches
> mortes à l'intérieur de fonctions vivantes** + un doublon homonyme. Les
> retirer proprement demande un **refactor délibéré, revu à part** (extraction
> branche par branche avec validation), pas une suppression automatisée. Reporté.

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

| Fichier | Constat | Action |
|---|---|---|
| `public/js/features/settings/SettingsModalContent.js` | **Mort auto-documenté** : le fichier déclare lui-même être un « dead legacy module … no longer mixed in or referenced anywhere ». Exposait un `window.SettingsModalContent = {}` vide, référencé nulle part ailleurs que sa balise `<script>`. | ✅ **Supprimé** (fichier + balise) |
| `public/js/features/midi-editor/MidiEditorToolbar.js` | `class MidiEditorToolbar` **jamais instanciée** ; méthodes toutes dupliquées par des modules vivants (`MidiEditorEditActions`/`Viewport`/`ChannelOps`) ; seules références externes = commentaires. | ✅ **Supprimé** (fichier + balise) |
| `public/js/features/piano-roll/PianoRollRenderer.js` | ⚠️ **PAS orphelin (correction)** : c'est la **classe de base** dont hérite le renderer vivant — `class CanvasPianoRollRenderer extends PianoRollRenderer` (`CanvasPianoRollRenderer.js:61`). La revue initiale s'était trompée. | ❌ **Conservé** (le retirer casserait le piano-roll) |

Deux fichiers orphelins retirés ; parité `<script>`/fichiers maintenue (188/188),
build et 1411 tests frontend verts après retrait.

**Branches mortes inline (dans `index.html`)** — voir §7 (rectifié) :
il existe des branches mortes (rendu `#deviceList`, mise à jour de modale sur
`device_identity`) et un `async function showInstrumentSettings` legacy dupliqué,
**mais imbriqués dans des fonctions vivantes** (`loadDevices` a 8 appelants ;
le proxy `window.showInstrumentSettings` est vivant). **Non supprimés** :
demande un refactor délibéré et revu, pas une suppression automatisée (risque de
casse pour gain fonctionnel nul).

---

## 9. Recommandations priorisées

### Priorité haute
- **Aucune régression bloquante.** L'UI existante fonctionne.

### Priorité moyenne (fonctionnalités attendues au câblage manquant)
1. ✅ **Contrôles de lecture temps réel** — **fait** : seek/tempo/volume/transpose
   exposés dans la barre de transport (voir « Correctifs appliqués »). Reste
   optionnel : loop A/B.
2. **Persistance des dossiers de fichiers** : brancher `moveFileToFolder` sur la
   commande `file_move` au lieu du seul `localStorage`.
3. **`system_lag`** : ajouter un écouteur + indicateur visuel (le backend fait
   déjà tout le travail de détection et d'envoi).
4. **`reconnect_exhausted`** : matérialiser l'état « connexion perdue » et
   stopper les spinners après abandon.
5. **`validate_routing_feasibility`** : brancher le bandeau d'avertissement
   prévu, ou documenter le report.

### Priorité basse (hygiène / dette)
1. ✅ **Clés i18n manquantes** — **fait** (35 + 5 clés `ui.*`, 28 locales).
2. ⏳ **Code legacy inline** de `index.html` (branches mortes entrelacées, §7
   rectifié) : à traiter en refactor délibéré. _(2 fichiers orphelins déjà
   supprimés.)_
3. Décider du sort des **sous-systèmes non branchés** (`route_*`, `latency_*`,
   `preset_*` génériques, `session_*`, admin `system_*`) : exposer ou retirer,
   pour clarifier la surface d'API.
4. Nettoyer les **broadcasts redondants** (`midi_event`, `device_connected`,
   `settings_applied`, `playlist_waiting`) ou leur ajouter un consommateur.
5. `aria-label` sur les boutons purement iconographiques.

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
