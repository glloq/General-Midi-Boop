# 13 — Complétude fonctionnelle vs spécification (lot L13)

**Date :** 2026-09-07 · **Base :** `00_BASELINE.md` (commit `8dc170e`, v0.8.1)
**Périmètre :** analyse et recoupement uniquement — **aucune ligne de code
modifiée par ce lot**. Les correctifs identifiés sont attribués à leur lot
propriétaire.
**Plage de findings :** F-138 → F-155.

> **Question posée par l'utilisateur** : *le système est-il complet et
> fonctionnel comme prévu ?*
> **Réponse courte, sans langue de bois : non.** Le socle est solide et la
> majorité des promesses est tenue, mais **trois familles d'écarts** restent
> ouvertes, dont une qui rend un sous-système entier (le routage MIDI live)
> inatteignable, et une qui fait qu'un réglage manipulé, sauvegardé et
> *simulé à l'écran* n'a **aucun effet** à la lecture. Le détail est en §7.

---

## 1. Méthode et correction de la base de mesure

### 1.1 Ce qui a été croisé

| Source | Volume | Exploitation |
|---|---|---|
| Commandes WS enregistrées | 270 | `scripts/audit/command-inventory.mjs --json`, rejoué ce jour |
| Diffusions WS (`broadcast*`) | 23 | scan `src/**` + croisement avec les `api.on()` du frontend |
| Écoutes frontend (`api.on`) | — | `public/js/**` **+ `public/index.html`** |
| Colonnes de base | 208 (hors colonnes triviales) | extraction de `migrations/*.sql` + comptage de références par couche |
| Écrans / modales | 58 fichiers `public/js/features/*` + 8 sous-dossiers | inventaire + points d'entrée |
| Promesses écrites | `README.md`, 15 docs `docs/`, 4 ADR, 24 pages `wiki/`, `TODO.md`, 2 roadmaps, `CHANGELOG.md` | lecture intégrale |

### 1.2 **Le chiffre « 123 commandes orphelines » du plan est faux — c'est 72**

`scripts/audit/command-inventory.mjs::collectFrontendCalls()`
(`scripts/audit/command-inventory.mjs:110`) ne scanne que
`walk(join(ROOT, 'public/js'), …)`. Or **`public/index.html` contient ~8 100
lignes de JavaScript inline** (le bloc 6206→14340, cf. V0.9_ROADMAP T7.10) qui
appelle des dizaines de commandes. Le scanner ignore ce fichier.

Mesure refaite en incluant `public/index.html` :

```
Commandes enregistrées          : 270
Atteignables depuis le frontend : 198   (dont 33 UNIQUEMENT depuis index.html)
ORPHELINES (0 référence)        :  72
   dont couvertes par des tests :  18
   dont documentées dans API.md :  56
   dont avec schéma de payload  :  30
```

Reproduction : `node /tmp/.../L13/scan3.mjs` (scan ligne à ligne de
`public/js/**/*.js` + `public/index.html` sur les 270 noms de commandes).

> **Conséquence pour L01** : la ligne « 123 commandes ne sont appelées par aucun
> frontend » du `PLAN_AUDITS.md` et du `00_BASELINE.md` doit être ramenée à
> **72**. Les 51 écarts sont des faux positifs dus au fichier non scanné.
> **Correctif proposé (lot L14 ou vague 2)** : ajouter `public/index.html` à
> `collectFrontendCalls()`.

### 1.3 États et niveaux

`PASS` / `PARTIAL` / `FAIL` / `NOT TESTED` / `HW REQUIRED`, niveau de validation
0→5 (0 = déclaratif, 1 = lu, 2 = statiquement prouvé, 3 = test automatisé,
4 = exécuté bout-en-bout, 5 = validé sur matériel).

---

## 2. LA MATRICE DE COMPLÉTUDE

Légende colonnes : **Promise** = où la fonctionnalité est annoncée · **BE** =
backend existe · **UI** = atteignable depuis l'interface · **Effet** = effet
réel prouvé · **Test** = couverture automatisée.

### 2.1 Transports & connectivité

| Fonctionnalité | Promise | BE | UI | Effet vérifié | Test | Verdict |
|---|---|---|---|---|---|---|
| USB MIDI + hot-plug | README §Connect | ✅ `DeviceDiscovery.js:302-311` | ✅ page Instruments | ❌ pas d'ALSA/`midi` en sandbox | partiel | **HW REQUIRED** · niv. 2 |
| Bluetooth LE MIDI (scan/pair) | README, wiki Hardware | ✅ `BluetoothCommands.js` (9 cmd) | ✅ `BluetoothScanModal` + index.html:14141+ | ❌ pas de D-Bus | codec testé, machine à états non | **HW REQUIRED** · niv. 2 |
| `ble_scan_stop` | — | ✅ | ❌ **orpheline** | — | ❌ | **PARTIAL** (surface orpheline) |
| RTP-MIDI / réseau | README (« experimental ») | ✅ `RtpMidiSession.js` | ✅ `NetworkScanModal` | handshake ✅, **journal RFC 6295 absent**, clock-sync sans estimation d'offset | ❌ | **PARTIAL** · niv. 2 — T4.2 ouvert |
| RTP-MIDI **« RFC 6295 »** | **wiki Home §Key Features** | ❌ journal non implémenté | — | — | — | **FAIL — promesse non tenue** (F-148) |
| MIDI IN/OUT GPIO UART 31250 | README, `GPIO_MIDI_WIRING.md` | ✅ `SerialMidiManager.js` | ✅ Réglages → Série | ❌ | 17 % couverture | **HW REQUIRED** · niv. 2 |
| `serial_list` / `serial_status` | — | ✅ | ❌ **orphelines** (l'UI utilise `serial_scan`/`serial_open`) | — | ❌ | **PARTIAL** (doublon orphelin) |
| `/api/capabilities` `ready/degraded/failed` | README encadré | ✅ | ✅ (dashboard) | ⚠️ F-01/F-02 : `usb`/`ble` mentent | ❌ | **PARTIAL** → **L12** |

### 2.2 Routage & adaptation automatiques

| Fonctionnalité | Promise | BE | UI | Effet vérifié | Test | Verdict |
|---|---|---|---|---|---|---|
| Auto-assignation de canaux (scoring 0-100) | README, `AUTO_ASSIGNMENT.md`, wiki | ✅ `InstrumentMatcher.js` (1584 l.) | ✅ `RoutingSummaryPage` | ✅ | ✅ 74-79 % | **PASS** · niv. 3 |
| Split d'un canal sur plusieurs instruments | README | ✅ `ChannelSplitter.js` | ✅ | ✅ | ✅ | **PASS** · niv. 3 |
| Adaptation de plage / polyphonie / drums | README, `AUTO_ASSIGNMENT.md` | ✅ `MidiTransposer`, `DrumNoteMapper` | ✅ | ✅ | ✅ | **PASS** · niv. 3 |
| `apply_assignments` → `handPositionWarnings` en UI | V0.9 T2.4 (« non câblé ») | ✅ `PlaybackAssignmentCommands.js:663` | ✅ **désormais câblé** `RoutingSummaryPage.js:3031-3044` | ✅ | jsdom | **PASS** — roadmap périmée (F-151) |
| `validate_routing_feasibility` (pré-assignation) | V0.9 T2.4 | ✅ `RoutingCommands.js:564`, 3 suites de tests vertes | ❌ **orpheline** | n/a | ✅ | **PARTIAL** — surface orpheline confirmée |
| Faisabilité main pré-assignation | — | ✅ backend | ✅ mais **réimplémentée côté client** (`HandPositionFeasibility.js:1-11` : « Client-side mirror ») | ✅ | ✅ | **PARTIAL** — duplication de logique |
| Atomicité de l'apply (T5.1) | V0.9 T5.1 | ⚠️ pas de transaction unique (`PlaybackAssignmentCommands.js:381-383`) | — | échec partiel signalé, non annulé | — | **PARTIAL** → **L07** |
| **Routage live source → destination** (`route_*`) | `docs/API.md:178-180`, wiki | ✅ `MidiRouter.js` (895 l.), tests verts | ❌ **AUCUNE UI** — 15 commandes orphelines, aucun moyen de créer une route | **jamais exécuté en usage nominal** | 6/15 | **FAIL — F-138** |
| Filtres de route / channel map | `docs/API.md` | ✅ | ❌ orphelines (dépendent d'une route inexistante) | — | ❌ | **FAIL** (dépendance F-138) |
| « inbound BLE notes are routed like any other input » | README §Connect | ✅ `DeviceManager.js:1526 → routeMessage` | ❌ pas de route configurable | avec 0 route : le message ne va qu'au moniteur (`MidiRouter.js:377`) | — | **FAIL — promesse non tenue** (F-138) |

### 2.3 Capacités d'instrument (l'axe « capacité morte »)

| Capacité (colonne) | Réglable UI | Persistée | Lue par le moteur | Verdict |
|---|---|---|---|---|
| `note_range_min/max`, `selected_notes`, `note_selection_mode` | ✅ | ✅ | ✅ `PlaybackScheduler`, `NoteEnforcement` | **PASS** |
| `polyphony`, `min_note_interval`, `min_note_duration` | ✅ | ✅ | ✅ (playback) — `min_note_duration` **non** appliqué au route-through live (`NoteEnforcement.js:91`) | **PARTIAL** |
| `supported_ccs` | ✅ | ✅ | ✅ playback (T1.4) **et** live (T1.5) | **PASS** |
| `octave_mode` / `scale_root` | ✅ | ✅ | ⚠️ **matérialisé** en `selected_notes` par l'UI (`ISMSave.js:283-286` : « the pipeline ignores `octave_mode` entirely ») | **PARTIAL** (contournement assumé) |
| `comm_timeout` | ✅ | ✅ | ✅ `DeviceManager._getCommTimeoutMs` (T1.6) | **PASS** |
| `omni_mode` | ✅ | ✅ | ✅ `MidiPlayer:2535 _getOmniFallback` | **PASS** |
| `voices_share_notes` + notes par voix | ✅ `ISMSections.js:871` (`#voicesShareNotesCheckbox`) | ✅ mig. 005 | ✅ playback `MidiPlayer:936-961` · ❌ live | **PARTIAL** — **T1.1(c) EST FAIT**, roadmap périmée (F-151) |
| `hands_config` (mains/doigts) | ✅ onglet Main | ✅ mig. 004/010 | ✅ `HandPositionPlanner`, `MidiBaker` | **PASS** |
| **`hand_position_overrides.hand_anchors`** | ✅ drag de la bande, « Pin anchor » (wiki Interface-Hand-Management) | ✅ mig. 009 | ❌ **jamais lu** — `MidiPlayer` ne lit que `note_assignments` (`MidiPlayer.js:779`) | **FAIL — capacité morte F-139** |
| **`hand_position_overrides.disabled_notes`** | ✅ `HandsPreviewPanel.js:722-728` | ✅ | ❌ **jamais lu** | **FAIL — capacité morte F-139** |
| `hand_position_overrides.note_assignments` | ✅ | ✅ | ✅ `MidiPlayer.js:779-786` · ❌ **ignoré par `MidiBaker`** | **PARTIAL — divergence live≠baké F-154** |
| **`string_instruments.is_fretless`** | ❌ **forcé à 0** par `ISMSave.js:267` à chaque enregistrement | ✅ | ✅ `TablatureConverter:78,146,751`, `MidiPlayer:1101`, `CapabilityResolver:177` | **FAIL — F-140** (le moteur la consomme, l'UI la détruit) |
| **`string_instruments.capo_fret`** | ❌ **forcé à 0** (`ISMSave.js:267`, `ISMListeners.js:96,152`) — clés i18n `capoFret`/`noCapo` orphelines | ✅ | ⚠️ lu seulement par la simulation client (`HandPositionFeasibility.js:1479`) | **FAIL — capacité morte F-140** |
| `cc_bow_direction_number` / `cc_bow_*_value` | ✅ `StringInstrumentConfigModal:301` | ✅ mig. 021 | ✅ `KeyboardChords.js:382-392` | **PASS** (jeu live) |
| `string_sliding_system_enabled`, `string_slider_enabled` | ✅ | ✅ | ✅ | **PASS** |
| **`pitch_bend_enabled`** | ✅ `ISMSections.js:1080` | ✅ mig. 034 | ⚠️ **gate seulement la molette du clavier virtuel** ; `PlaybackScheduler` émet le pitch bend inconditionnellement | **PARTIAL — capacité semi-morte F-146** |
| `custom_sf2_id` | ✅ `#customSf2Id` | ✅ mig. 019 | ✅ `AudioPreview.js:234` (preview navigateur) | **PASS** |
| `lighting_enabled` + `instrument_light_state` (CC 110-114) | ✅ ISM + LightingControlPage | ✅ mig. 024/027-029 | ✅ `InstrumentLightController` | **PASS** — mais annoncé « Planned » au README (F-151) |
| **`instruments_latency.descriptor_revision` / `descriptor_json`** | ❌ | ✅ mig. 033 | ❌ **0 référence dans tout le dépôt** | **FAIL — capacité morte F-143** |
| `capabilities_source = 'descriptor'` | — | contrainte `CHECK` non élargie | ❌ `DescriptorService.js:41` force `'auto'` | **FAIL — T1.8 ouvert (F-143)** |
| `avg/min/max_latency`, `jitter`, `std_deviation`, `measurement_count`, `measurement_history`, `calibration_confidence`, `calibration_method`, `last_calibration` (9 colonnes) | ❌ (seules `latency_*`, orphelines, les écrivent) | ✅ | ❌ | **FAIL — sous-système mort F-147** |
| `instrument_light_config` (**33 colonnes**, mig. 025/026) | ❌ | ✅ | ❌ — remplacée par `instrument_light_state` (mig. 027 le documente) | **Dette de schéma** (nettoyage T7) |
| `instruments_latency.midi_clock_enabled` | ❌ (l'UI écrit `devices.midi_clock_enabled`) | ✅ | ❌ le générateur lit `devices.*` (`MidiClockGenerator.js:163`) | **Colonne morte en doublon** |
| `presets.is_favorite`, `sessions.last_opened`, `devices.port_id` | ❌ | ✅ | ❌ | **Dette de schéma** |
| `bagpipe_config` / `accordion_config` / `harmonica_config` | ✅ | ✅ mig. 022/023 | ✅ vues clavier (T1.3 — sémantique de vue, pas de playback) | **PASS** (arbitrage documenté) |

#### Capacités mortes supplémentaires confirmées par le lot L06 (croisement)

Le rapport `06_ROUTING_ADAPTATION.md`, rendu pendant ce lot, confirme F-143
(son F-67), F-146 (F-66) et F-144 (F-71), et **ajoute quatre capacités mortes
que ce lot n'avait pas isolées**. Elles entrent de plein droit dans la matrice :

| Capacité | Constat L06 | Finding L06 |
|---|---|---|
| `midi_instrument_routings.behavior_mode` | écrit par `PlaybackAssignmentCommands.js:503`, relu par personne → **le choix « overflow »/« alternate » est perdu au rechargement** | F-65 |
| `instrument_voices.{min_note_interval, min_note_duration, supported_ccs, octave_mode, scale_root}` (5 colonnes/voix) | écrites et validées, `VoiceSelector.js` ne les nomme même pas — alors que la Phase 8 §4 de la roadmap familles les exige | F-70 |
| `shared/gm-instrument-capabilities.json` (128 × 6 champs) | seul `name` est consommé ; `getGmDefaultPolyphony()` sans appelant ⇒ **aucune monophonie de famille** : un instrument à vent sans `polyphony=1` saisi à la main reçoit l'accord entier | F-73 |
| `octave_mode` / `scale_root` sans validation ; scoring aveugle à `octave_mode` en mode `range` | `octave_mode='banana'` accepté → retour silencieux au chromatique ; un instrument pentatonique est noté comme un chromatique | F-68, F-69 |

Un point d'attention pour F-140 : L06 (F-72) relève que
`DescriptorProtocol.js:360` mappe `physical.capo → capo_fret`. Le `capo_fret`
inerte cesse donc d'être inoffensif dès que T1.8 aboutit — **le traiter avant
de livrer le descripteur v2**, pas après.

**Écart de sévérité assumé avec L06.** L06 classe ces capacités mortes en P2 et
conclut « 0 P1 ». Ce lot en classe trois en **P1**, non par désaccord technique
mais par référentiel : la définition que le projet s'est donnée
(`V0.9_ROADMAP.md` §1) fait de « plus aucune capacité morte » un **critère
d'acceptation** de la v0.9. Une capacité morte n'est donc pas un défaut de
qualité parmi d'autres — c'est, littéralement, ce qui empêche de tagger la
version.

### 2.4 Lecture, playback, timing

| Fonctionnalité | Promise | BE | UI | Effet | Test | Verdict |
|---|---|---|---|---|---|---|
| Lecture / pause / stop / seek | README, wiki | ✅ | ✅ | ✅ | ✅ | **PASS** · niv. 3 |
| Tempo / volume / transposition runtime | wiki | ✅ | ✅ (`BackendAPIClient:702,710`) | ✅ | ✅ | **PASS** |
| **Boucle de lecture (`playback_set_loop`)** | V0.9 T2.10 | ✅ `MidiPlayer.setLoop:1947` + `_handleFileEnd:2917` | ❌ **aucun bouton** | inatteignable | ✅ 1 test | **FAIL — T2.10 confirmé (F-145)**. NB : c'est une **boucle fichier entier**, pas un « loop A/B » comme l'écrit la roadmap |
| Compensation de latence par device | README | ✅ `LatencyCompensator`, `sync_delay` | ✅ via `instrument_update_settings` | ✅ | ✅ | **PASS** · niv. 3 |
| Calibration micro | README, wiki Interface-Microphone | ✅ `calibrate_*` (5 cmd) + `DelayCalibrator` | ⚠️ bouton **masqué par défaut** | ❌ (audio) | partiel | **PARTIAL — F-153** · HW |
| Accordeur chromatique | wiki Interface-Microphone | ✅ `tuner_*` (3 cmd) | ⚠️ **doublement caché** (uniquement depuis la modale Calibration, elle-même masquée) | ❌ | partiel | **PARTIAL — F-153** |
| Horloge MIDI optionnelle | README | ✅ `MidiClockGenerator` | ✅ `DeviceSettingsModal:212` | ❌ | 0,5 % couverture | **NOT TESTED** → **L03** |
| Playlist / file d'attente / gap | README, wiki | ✅ 15 cmd | ✅ `PlaylistPage`, `PlaylistEditorModal` | ✅ | partiel | **PASS** · niv. 2 |
| `playlist_clear` / `playlist_status` | — | ✅ | ❌ orphelines | — | ❌ | **PARTIAL** |
| Injection de program-change multi-voix | V0.9 T1.1 | ✅ `MidiPlayer._injectVoiceProgramChangeEvents` | ✅ (implicite) | ✅ playback · **❌ route-through live** | 21 tests | **PARTIAL — T1.1(b) confirmé (F-144)** |
| Déterminisme / live = baké | V0.9 T3 | T3.1→T3.4 fermés | — | ⚠️ **nouvelle divergence** : `MidiBaker` ignore les pins de main | — | **PARTIAL — F-154** → croiser **L05** |

### 2.5 Édition MIDI

| Fonctionnalité | Promise | BE | UI | Effet | Test | Verdict |
|---|---|---|---|---|---|---|
| Piano roll (add/move/resize, 16 canaux, grille) | README, `MIDI_EDITOR.md` | ✅ | ✅ `CanvasPianoRollRenderer` (2027 l.) | ✅ | Vitest | **PASS** · niv. 3 |
| Bascule Canvas V2 | V0.9 T4.3 « **reporté, opt-in** » | — | ❌ le flag `?pianoRollV2=1` **n'existe plus**, la lib legacy est **supprimée**, V2 est le **seul** renderer (`MidiEditorPianoRollBoot.js:56-76`) | ✅ | Vitest | **Roadmap FAUSSE — F-150**. La porte « bêta 2 semaines + QA navigateur » du plan n'a jamais été franchie |
| Tablature bidirectionnelle | README | ✅ `TablatureConverter` (1524 l.) | ✅ `TablatureEditor` | ✅ | ✅ | **PASS** |
| `tablature_delete` / `tablature_get_by_file` | — | ✅ | ❌ orphelines | — | ❌ | **PARTIAL** |
| Éditeur Drums (grille GM) | README | ✅ | ✅ `DrumPatternEditor` | ✅ (quantize branché `:262-271`) | ✅ | **PASS** |
| Éditeur Vents (articulation/souffle) | README | ✅ | ✅ `WindInstrumentEditor` (pan/select branchés `:171-172`) | ✅ | ✅ | **PASS** |
| Mode tactile (Move/Add/Resize) | README | — | ✅ | ❌ | ❌ | **NOT TESTED** → **L08** |
| Canal muté « ghost » dans le rendu | TODO §4.1 | — | ❌ décision UX non prise | — | — | **Ouvert (non bloquant)** |
| Store MIDI central / `ChannelState` | TODO §1.2, §4.2 · V0.9 T7.7 | phase 1 partielle | — | — | — | **Dette assumée** |

### 2.6 Boucles, arrangements, jeu live

| Fonctionnalité | Promise | BE | UI | Effet | Test | Verdict |
|---|---|---|---|---|---|---|
| Bibliothèque de boucles | README, wiki Loop-Manager | ✅ `loop_*` (5 cmd) | ✅ `LoopManagerLibraryFeature` | ✅ | ✅ | **PASS** |
| Pad de déclenchement / vue Live / Arranger | README, wiki | ✅ `arrangement_*` (11 cmd, 10 schémas) | ✅ 4 features | ✅ | ✅ | **PASS** · niv. 3 |
| Clavier virtuel + vues spécialisées (16) | README, `piano-virtual-modal.md`, wiki | ✅ | ✅ `InstrumentViewRegistry` | ✅ | 544 cas Vitest | **PASS** · niv. 3 |
| Preview original ↔ adapté | README | ✅ | ✅ `AudioPreview.js:80,151` | ✅ | ✅ | **PASS** |
| SF2 par instrument | README | ✅ `/api/sf2` + `custom_sf2_id` | ✅ | ✅ (preview navigateur) | partiel | **PASS** · niv. 2 |
| « `_selectProgram` envoie un `midi_send type:program` **au device** » | roadmap familles Phase 0b | ❌ | preview **navigateur** uniquement (`InstrumentSettingsModal.js:1248-1290`) | — | — | **Claim inexacte** (F-151) |

### 2.7 Lumière

| Fonctionnalité | Promise | BE | UI | Effet | Test | Verdict |
|---|---|---|---|---|---|---|
| 8 drivers (ArtNet, sACN, OSC, HTTP/WLED, MQTT, GPIO ×2, Serial) | README, wiki | ✅ | ✅ `LightingControlPage` | ❌ | **0 %** (F-13, P1) | **NOT TESTED** → **L02** |
| Moteur de règles + MIDI-learn | README | ✅ | ✅ (36/38 commandes câblées) | ❌ | 0 % | **NOT TESTED** → **L02** |
| Retour temps réel `lighting_device_status` / `lighting_led_state` / `lighting_effect_change` | — | ✅ diffusés + priorisés (`WsOutputQueue.js:70-71`) | ❌ **aucun `api.on()` dans tout le frontend** | diffusés dans le vide | ❌ | **FAIL — F-152** |
| `lighting_scene_apply` / `lighting_led_broadcast` | `docs/API.md` | ✅ | ❌ orphelines (`lighting_preset_load` couvre les scènes) | — | ❌ | **PARTIAL** — commentaire périmé `LightingCommands.js:277` |
| Lumière embarquée pilotée par MIDI CC | README : **« Planned »** | ✅ **livré** (mig. 024-029, `InstrumentLightCommands`, `InstrumentLightCC` CC 110-114) | ✅ ISM + LightingControlPage | ✅ | ❌ | **README sous-déclare — F-151** |
| Bouton « Lumière » dans l'en-tête | README (feature phare) | — | ⚠️ **masqué par défaut** (`SettingsModal.js:95`) | — | — | **PARTIAL — F-153** |

### 2.8 Système, exploitation, offline-first

| Fonctionnalité | Promise | BE | UI | Effet | Test | Verdict |
|---|---|---|---|---|---|---|
| Hotspot WiFi + portail captif | README | ✅ `HotspotCommands` (10), `captivePortal.js` | ✅ `SettingsHotspot` | ❌ | ❌ | **HW REQUIRED** → **L11** |
| Mise à jour un bouton | README | ✅ `system_update` + `scripts/update.sh` | ✅ `SettingsUpdate` | ❌ | 19 % | **NOT TESTED** → **L11** |
| Offline-first | README | — | ❌ **`index.html:6011` fait un `document.write` bloquant vers un CDN** (F-14) | — | — | **FAIL** → **L11** |
| Administration système (`system_*`) | V0.9 T2.6 | ✅ | ✅ `SystemAdminModal` | ❌ | jsdom | **PASS** (câblage) · niv. 3 |
| Sessions (`session_*`) | V0.9 T2.7 | ✅ 6 cmd | ✅ save/list/load/export/delete · ❌ `session_import` orpheline | — | ✅ | **PARTIAL** |
| Restauration de sauvegarde | V0.9 T5.3 | ⚠️ `SystemCommands.js:667` lève « Restore is not supported by this database backend » | ✅ bouton exposé | — | — | **PARTIAL** — bouton qui peut échouer par conception |
| Dossiers de fichiers persistés serveur | V0.9 T2.2 | ✅ `file_folders_get/set` | ✅ `index.html:7773` | ✅ | ✅ | **PASS** (mesuré orphelin à tort par le scanner — cf. §1.2) |
| Export / téléchargement d'un fichier MIDI | `docs/API.md` (`file_export`, `/api/files/:id/blob`) | ✅ | ❌ **aucun bouton de téléchargement dans toute la SPA** | — | ❌ | **PARTIAL** (surface orpheline) |
| Presets de configuration (`preset_*`) | `docs/API.md`, table `presets` | ✅ 6 cmd, 6 schémas, 6 testées | ❌ **aucune UI** | — | ✅ | **FAIL — sous-système orphelin (F-152)** |
| 28 langues | README, wiki | 2 737 clés × 28 locales, 0 clé manquante | ✅ | ⚠️ **68 %→88 % réellement traduites** (tl 68,1 %, hi 69,6 %, da 72,7 %…) | — | **PARTIAL** → **L09** (F-12) |

### 2.9 Contrat d'API et versionnement

| Promesse | Où | Réalité | Verdict |
|---|---|---|---|
| « versioned-handler lookup » dans le pipeline de dispatch | `CLAUDE.md` §Command pattern, `CommandRegistry.js:10-11,126` | `CommandRegistry.handle()` fait `this.handlers[message.command]` (`:178`) — **`message.version` n'est lu nulle part** | **FAIL — F-141** |
| ADR-003 : rupture ⇒ commande `v2` additive | `docs/adr/ADR-003` (Accepté) | Aucun mécanisme de version côté serveur | **FAIL — F-141** |
| ADR-004 : « 100 % des commandes playback et routing ont un schéma » | `docs/adr/ADR-004:257` | playback **8/23**, routing **8/21**, global **86/270 (31,9 %)** ; `validateByCommand` **fail-open** (`JsonValidator.js:252`) | **FAIL — F-142** (croise F-03 / **L01**) |
| ADR-004 : « les 33 `case` du switch remplacés » | idem | 5 `case` résiduels dans `JsonValidator.js` | **PARTIAL** |
| wiki : « 146 commandes sur 15 modules » | `wiki/API-Reference.md` | **270** commandes, 26 modules ; **17 noms de commandes cités n'existent pas** (`routing_set`, `auto_assign_apply`, `bluetooth_pair`, `lighting_set_color`, `bank_select`, `instrument_voice_select`, …) | **FAIL — F-148** |
| `docs/API.md` | — | 201 lignes de tableau ; **5 « événements » jamais diffusés** (`file_uploaded`, `midi_message`, `midi_routed`, `playback_started`, `playback_stopped`) ; **84 commandes non documentées** | **PARTIAL — F-149** |

---

## 3. Re-statut, avec preuve, des points ouverts v0.9

| Point | État déclaré (2026-08-07) | **État vérifié dans le code (2026-09-07)** | Preuve |
|---|---|---|---|
| **T1.1(b)** injection de voix en route-through live | ouvert | **CONFIRMÉ OUVERT** — `MidiRouter.js` ne contient aucune référence à `VoiceSelector`/`selectVoiceProgram` ; seul `MidiPlayer.js:32,961` l'importe. Aggravé : le route-through live est de toute façon inatteignable (F-138) | grep `VoiceSelector` sur `src/` |
| **T1.1(c)** `voices_share_notes` exposé en UI | « à vérifier » | **FAIT** — case `#voicesShareNotesCheckbox` rendue (`ISMSections.js:868-871`), câblée (`ISMListeners.js:1242-1254`), sauvegardée (`ISMSave.js:169,418`) | lecture code |
| **T1.8** pipeline descripteur v2 | partiellement câblé | **CONFIRMÉ OUVERT, et pire que déclaré** — `descriptor_revision`/`descriptor_json` (mig. 033) ont **0 référence** dans `src/`, `public/` et `tests/` ; aucun chemin HTTP (`grep descriptorUrl` = vide) ; `applyDescriptor` est appelé **sans** `previousDescriptor` ni `overriddenFieldsByChannel` (`DeviceManager.js:615`) → le diff §6 ne s'exécute jamais ; `_source='auto'` figé (`DescriptorService.js:41`) | greps ci-dessus |
| **T2.4** `validate_routing_feasibility` | non câblée | **CONFIRMÉ OUVERT** (orpheline) — mais la moitié « `handPositionWarnings` de `apply_assignments` » **est câblée** (`RoutingSummaryPage.js:3031-3044`) | inventaire + lecture |
| **T2.10** boucle de lecture | non exposé | **CONFIRMÉ OUVERT** — 0 occurrence de `playback_set_loop` dans `public/` ; et le backend n'implémente **pas** un loop A/B mais une reprise à 0 en fin de fichier (`MidiPlayer.js:2917`) | grep + lecture |
| **T3** live ≠ baké | T3.1→T3.4 fermés | **NOUVELLE DIVERGENCE** : `MidiBaker` n'ouvre jamais `hand_position_overrides` alors que `MidiPlayer.js:779` honore `note_assignments` ⇒ le même fichier joué en direct et baké diffère sur les CC de main. `min_note_duration` reste playback-only (`NoteEnforcement.js:91`) | grep `overrides` sur `src/files/MidiBaker.js` = vide |
| **T4.1** `independent_fingers` | retenu v0.9, non commencé | **CONFIRMÉ OUVERT** — verrou intact aux 3 niveaux : `HandPositionPlanner.js:118-120` (throw), `InstrumentCapabilitiesValidator.js:280,589` (rejet), carte UI grisée | lecture code |
| **T4.2** journal RTP-MIDI RFC 6295 | retenu v0.9, non commencé | **CONFIRMÉ OUVERT** — aucun `journal`/`recovery` dans `src/transports/RtpMidiSession.js` | grep |
| **T4.3** Canvas V2 | « **reporté**, reste opt-in » | **DÉCISION NON TENUE — dans l'autre sens** : le flag a disparu, `webaudio-pianoroll-custom.js` n'existe plus, `CanvasPianoRollRenderer` est l'unique implémentation (`PianoRollRenderer.js:12`, `MidiEditorPianoRollBoot.js:56-76`). La bascule a eu lieu **sans** la bêta ni la QA navigateur exigées | `find public -name "*pianoroll*"` = vide |
| **T5.1** atomicité de l'apply | ouvert | **CONFIRMÉ OUVERT** — commentaire explicite `PlaybackAssignmentCommands.js:381-383` | lecture |
| **T5.2** `NobleBleAdapter` non branché | ouvert | **CONFIRMÉ OUVERT** — `NobleBleAdapter.js:8-12` « additive infrastructure », TODO présent | lecture |
| **T5.3** restore non supporté | ouvert | **CONFIRMÉ OUVERT** — `SystemCommands.js:667` | lecture |
| **T7.5** « `latency_*` n'est pas mort » | claim « corrigée » | **CLAIM INFIRMÉE** — ce qui vit, c'est `calibrate_*` (5 cmd, `CalibrationModal.js:462-585`) et la diffusion `latency_calibration_complete`. Les **8 commandes `latency_*`** n'ont **aucun appelant frontend**, et le résultat de calibration est persisté via `instrument_update_settings` (`CalibrationModal.js:686`), pas via `latency_set` | grep `latency_` sur `public/` → 1 seul hit, un `api.on()` |
| **T8.5** boutons masqués | « décision produit à confirmer » | **CONFIRMÉ** — `showCalibrationButton:false`, `showLightingButton:false` (`SettingsModal.js:94-95`) ; effet : lumière, calibration **et l'accordeur** invisibles par défaut | lecture |

---

## 4. Cohérence des roadmaps entre elles — items cochés à tort

| Item | Document | Statut déclaré | Réalité mesurée | Sens de l'erreur |
|---|---|---|---|---|
| T4.3 Canvas V2 | `V0.9_ROADMAP.md` §T4.3 + `TODO.md` §Phase C | ⏸ reporté, opt-in | **Livré et par défaut**, lib legacy supprimée | **Sous-déclaré** (F-150) |
| T1.1(c) `voices_share_notes` UI | `V0.9_ROADMAP.md` §T1.1 | « restant » | **Fait** | Sous-déclaré (F-151) |
| T2.4 `handPositionWarnings` d'`apply_assignments` | `V0.9_ROADMAP.md` §T2.4 | « non câblé » | **Câblé** | Sous-déclaré (F-151) |
| Phase 0c « `_save` persiste via `instrument_voice_replace` » | `INSTRUMENT_FAMILY_REFACTOR_ROADMAP.md` | ✅ livré | **Faux** : le frontend n'appelle que `instrument_voice_list` ; la persistance passe par `instrument_update_settings.voices` → `replaceVoices`. Les 4 commandes `instrument_voice_{create,update,delete,replace}` sont **orphelines** | Claim inexacte |
| Phase 0b « `midi_send type: program` au device » | idem | ✅ livré | **Faux** : le program change vise le synthé **navigateur** (`InstrumentSettingsModal.js:1248`) ; `midi_send` est orpheline | Claim inexacte |
| Phase 1 assets SVG « 68/128 déployés » | idem | ✅ livré (partiel) | cohérent — 60 fallback emoji restants | OK |
| Phase 3 / Phase 5 (taxonomie familles) | idem | ⏳ à faire | cohérent avec V0.9 T7.3/T7.4 | OK |
| Phase 8 moteur multi-voix | idem, ⏳ à faire | vs V0.9 T1.1 « livré + testé » | **Contradiction directe entre les deux roadmaps** sur le même sujet | Incohérence |
| T7.1 tailles des monolithes | `V0.9_ROADMAP.md` + `TODO.md` | `MidiPlayer` 2202/2061 · `RoutingSummaryPage` ~2980 · `ISMSections` 2596/2213 · `LoopCreatorModal` 1944 | **3024** · **3550** · **3028** · **853** | Chiffres périmés ; les monolithes **ont grossi** (F-155) |
| `keyboard.css` 252 `!important` | `TODO.md` | 252 | **124** | Périmé (amélioré) |
| CSS total `!important` | V0.9 T7.9 « ~685 » | 685 | **685** | Exact |
| `CHANGELOG.md` | — | dernière entrée **0.8.2 — 2026-05-17** | ~15 migrations (020→034), descripteur v2, arrangements, hotspot, SF2, voix, mains : **rien n'y figure** ; la section `[Unreleased]` est classée **sous** `[0.7.0]` | Périmé (F-155) |
| `package.json` 0.8.1 vs roadmap/wiki « v0.8.2 » | — | — | incohérence de version persistante | → **L14** |
| `docs/MIDI_EDITOR.md` « `public/js/views/components/midi-editor/` » | — | — | chemin renommé en `features/` depuis longtemps | → **L14** |

---

## 5. Findings F-138 → F-155

> Sévérités : **P0** bloquant produit · **P1** bloque « 100 % fonctionnel » ·
> **P2** écart notable · **P3** dette / documentation.

### F-138 — P1 — Le routage MIDI live est entièrement inatteignable depuis l'UI

15 commandes (`route_create/delete/list/info/enable/duplicate/export/import/clear_all/test`,
`filter_set/clear`, `channel_map`, `file_routing_bulk_sync`,
`validate_routing_feasibility`) sont enregistrées, 8 ont un schéma, 6 sont
testées, 14 sont documentées dans `docs/API.md` — et **aucune n'est appelée par
le frontend**. Or `MidiRouter.addRoute()` (`src/midi/routing/MidiRouter.js:168`)
n'est atteint que par `route_create`, `session_load` (qui ne peut restituer que
des routes déjà créées) et la ré-hydratation DB. **Il n'existe donc aucun moyen,
depuis l'interface, de créer une route source → destination.**

Conséquences en cascade :
- `MidiRouter.routeMessage` (`:333-378`) avec 0 route ne fait qu'alimenter le
  moniteur ⇒ la promesse README « *inbound BLE notes are routed like any other
  input* » n'est pas tenue ;
- tout le travail de T1.5 (`NoteGate` live), du clamp de capacités live et du
  correctif L06 F-64 porte sur un chemin qu'un utilisateur ne peut pas activer ;
- `docs/API.md:178-180` documente `route_create`/`route_list` comme utilisables.

**Correctif** : soit exposer une matrice de routage (chantier UI, ~5-8 j), soit
documenter explicitement ces 15 commandes comme API externe/headless et retirer
la promesse README. **Décision produit requise.** Lot : **L01** (statut des
commandes) + chantier UI.

### F-139 — P1 — `hand_anchors` et `disabled_notes` : capacité morte

Les éditeurs de position de main laissent l'opérateur **déplacer la bande de
main** et **désactiver des notes** ; les deux sont sérialisés dans
`midi_instrument_routings.hand_position_overrides` (migration 009), relus au
rechargement et **honorés par la simulation client**
(`HandPositionFeasibility.js:664-677`). Le moteur, lui, ne lit que
`note_assignments` (`MidiPlayer.js:779-786`) : `hand_anchors` et
`disabled_notes` **n'ont aucun effet sur la sortie MIDI**. La migration l'admet
elle-même (`009_…:15-17` : « *Applying an override is the future MidiPlayer's
job (out of scope for E.6.1)* »), mais le wiki présente ces contrôles comme
opérationnels (`wiki/Interface-Hand-Management.md` : « *Drag the hand band → Move
the anchor interactively* », « *Pin anchor → Lock the hand to the current
position* »).

C'est le cas d'école visé par la définition v0.9 : **l'utilisateur voit son
réglage appliqué à l'écran et rien ne change à la lecture.**

**Correctif** : consommer `hand_anchors` (ancrages épinglés) et `disabled_notes`
dans `HandPositionPlanner`/`MidiPlayer._injectHandPositionCCEvents`, **et** dans
`MidiBaker`. Estimation **3-5 j** + tests. Lot : **L06** (moteur) / **L05**
(déterminisme).

### F-140 — P1 — `is_fretless` et `capo_fret` remis à 0 à chaque enregistrement d'instrument

`ISMSave.js:266-267` construit `stringInstrumentPayload` avec
`is_fretless: 0, capo_fret: 0` **en dur** — aucune lecture d'un contrôle UI.
Ce payload est transmis à `instrument_update_settings`, qui l'écrit tel quel
(`InstrumentSettingsCommands.js:788-789`) via un UPSERT sur
`(device_id, channel)`. Idem `ISMListeners.js:96,152`.

- `is_fretless` **est consommée par le moteur** : `TablatureConverter.js:78,146,751,959,1055,1090`,
  `MidiPlayer.js:1101`, `CapabilityResolver.js:177`. Un violon/violoncelle/basse
  fretless créé via `string_instrument_create_from_preset`
  (`StringInstrumentDatabase.js:158-167`, `fretless: true`) **perd son
  caractère fretless dès la première ouverture-sauvegarde du modal Réglages**.
- `capo_fret` n'est lue que par la simulation client
  (`HandPositionFeasibility.js:1479-1480`) ; les clés i18n `capoFret` / `noCapo`
  / `capo` existent dans les 28 locales mais **ne sont référencées par aucun
  code** — vestige d'un contrôle retiré.

**Correctif** : (a) exposer `is_fretless` dans l'onglet Cordes ou, à défaut,
**préserver la valeur existante** au lieu de la forcer ; (b) trancher
`capo_fret` — l'exposer ou retirer colonne + clés i18n. Estimation **1-2 j**.
Lot : **L06** (capacités) + **L07** (intégrité).

### F-141 — P2 — Le dispatcher WebSocket ignore `message.version` (ADR-003 non implémenté)

`CommandRegistry.js:10-11` annonce « *Handler lookup (versioned handlers take
priority when the client sends `version`; falls back to the v1 handler
otherwise)* », `:126` répète « *looks up the handler (versioned > default)* », et
`CLAUDE.md` §Command pattern décrit « *versioned-handler lookup* » comme une
étape du pipeline. **Le code ne fait rien de tel** : `:178` est
`const handler = this.handlers[message.command];`. Aucune structure de handlers
par version n'existe (`grep -n "versionedHandlers\|registerVersioned"` = vide).
`CURRENT_API_VERSION` n'est qu'une constante renvoyée dans la réponse.

Conséquence : la stratégie d'évolution du contrat définie par **ADR-003
(statut « Accepté »)** — « en cas de rupture, introduire une commande `v2`
additive » — n'a aucun support d'exécution ; un client envoyant `version: 2`
reçoit silencieusement la v1.

**Correctif** : implémenter le lookup, **ou** corriger les 3 docstrings +
`CLAUDE.md` + passer ADR-003 en « Superseded ». Estimation **0,5 j** (doc) /
**2 j** (implémentation). Lot : **L01**, arbitrage **L14**.

### F-142 — P2 — Les critères de sortie d'ADR-004 ne sont pas atteints ; validateur fail-open

`docs/adr/ADR-004:255-262` fixe « *100 % des commandes playback et routing ont
un schéma déclaratif* ». Mesure du jour :

| Domaine | Commandes | Schémas | % |
|---|---|---|---|
| Playback (4 modules `src/midi/playback/commands/`) | 23 | 8 | 35 % |
| Routing (`RoutingCommands.js`) | 21 | 8 | 38 % |
| Lighting | 38 | 7 | 18 % |
| **Global** | **270** | **86** | **31,9 %** |

Et `JsonValidator.validateByCommand` **échoue en ouvert** :
`if (!compiled) return { valid: true, errors: [] };` (`:252`). 184 commandes
acceptent donc n'importe quel payload. Le plan de migration P1-3.2c (file,
instrument, session, playlist, lighting, stringInstrument, device, preset,
virtual) est resté à l'état de plan : `PlaylistCommands`, `StringInstrumentCommands`,
`InstrumentSettingsCommands`, `SerialCommands`, `InstrumentVoiceCommands`,
`InstrumentLightCommands`, `DeviceSettingsCommands`, `PlaybackRoutingCommands`
sont à **0 %**.

C'est F-03 vu depuis la spécification : ce n'est pas seulement une dette de
sécurité, c'est **un critère de sortie d'ADR non tenu**. Lot : **L01**.

### F-143 — P2 — T1.8 : le cache descripteur v2 est du schéma mort

- `migrations/033_descriptor_cache.sql` ajoute `descriptor_revision` et
  `descriptor_json` à `instruments_latency`. **Zéro référence** à ces deux
  colonnes dans `src/`, `public/` et `tests/`. Le cache ETag et le diff §6
  qu'elles doivent servir ne peuvent pas fonctionner.
- `DeviceManager.js:615` appelle `applyDescriptor(deviceName, parsed)` **sans**
  `previousDescriptor` ni `overriddenFieldsByChannel` ⇒ `diffOverrides` compare
  toujours contre `null` : la purge de surcharges §6 est inerte.
- `DescriptorService.js:41` fige `this._source = 'auto'` ;
  `capabilities_source='descriptor'` n'est jamais produit (contrainte `CHECK`
  non élargie — rebuild de table requis, cf. `docs/SYSEX_IDENTITY.md` §12).
- Aucun chemin HTTP de récupération de descripteur (`grep descriptorUrl|fetchDescriptor` = vide).

**Correctif** : tranche « persistance + diff » (lecture/écriture des 2 colonnes,
alimentation de `previousDescriptor`, table de surcharges par champ) puis
migration de rebuild pour `'descriptor'`. Estimation **4-6 j** avec base réelle
(désormais disponible). Lot : **L06** + **L07** (migration).

### F-144 — P2 — T1.1(b) : pas d'injection de voix sur le route-through live

`src/midi/routing/MidiRouter.js` n'importe ni `VoiceSelector` ni
`planVoiceProgramChanges` (seul `MidiPlayer.js:32` le fait). Un instrument
multi-voix joué **en direct** depuis un contrôleur reste donc sur son programme
GM primaire, alors qu'en lecture de fichier la voix est commutée. Divergence de
comportement pour la même donnée de configuration.

Aggravant : cette différence n'est aujourd'hui pas observable, faute d'UI pour
créer une route (F-138). Estimation **1-2 j** une fois F-138 tranché. Lot : **L06**.

### F-145 — P3 — T2.10 : boucle de lecture non exposée, et mal nommée dans la roadmap

`playback_set_loop` a un schéma (`playback.schemas.js:37`), un test, une
implémentation (`MidiPlayer.setLoop:1947`, effet réel en `_handleFileEnd:2917`)
et **zéro appelant frontend**. Par ailleurs la roadmap parle de « loop **A/B** » :
le backend ne connaît **pas** de points A/B — c'est une reprise à 0 en fin de
fichier. Toute UI construite sur la description de la roadmap serait mal
spécifiée.

**Correctif** : bouton 🔁 dans la barre de transport (~0,5 j) + corriger le
libellé de la roadmap. Lot : chantier UI.

### F-146 — P2 — `pitch_bend_enabled` n'a aucun effet sur la sortie

La case `#pitchBendEnabled` (`ISMSections.js:1080`) est persistée
(mig. 034, `InstrumentCapabilitiesDB.js:353`) et **gate uniquement l'affichage
de la molette du clavier virtuel** (`KeyboardControls.js:179`,
`KeyboardSlider.js:279`, `KeyboardWind.js:134`). En lecture de fichier,
`PlaybackScheduler._dispatchToDevice` émet le pitch bend **inconditionnellement**
(branche `MIDI_EVENT_TYPES.PITCH_BEND`), sans consulter la capacité — alors que
les CC, eux, sont filtrés par `supported_ccs` (`_isCCSupported:303`). Un
instrument mécanique déclaré sans pitch bend reçoit donc quand même les
messages, ce que T1.4 visait précisément à empêcher.

**Correctif** : aligner le pitch bend sur la politique CC (playback **et** live).
Estimation **0,5 j** + tests. Lot : **L06**.

### F-147 — P3 — Le sous-système de mesure de latence est mort (8 commandes + 9 colonnes)

`latency_measure/set/get/list/delete/auto_calibrate/recommendations/export` :
**aucun appelant frontend** (`grep "latency_" public/` ne rend qu'un `api.on()`
sur la diffusion `latency_calibration_complete`, `index.html:7725`). Le workflow
réellement utilisé est `calibrate_*` → `CalibrationModal._applyResults()` →
**`instrument_update_settings`** (`CalibrationModal.js:686`).

Corollaire : les 9 colonnes de statistiques (`avg_latency`, `min_latency`,
`max_latency`, `jitter`, `std_deviation`, `measurement_count`,
`measurement_history`, `calibration_confidence`, `calibration_method`,
`last_calibration`) ne sont écrites que par ces commandes orphelines et lues par
personne — la « *confidence scoring* » annoncée par `wiki/Home.md` n'est jamais
persistée.

**Ceci infirme la claim de `V0.9_ROADMAP` T7.5** (« `latency_*` **n'est pas
mort** »), qui confond `latency_*` et `calibrate_*`.

**Correctif** : décider — retirer les 8 commandes + colonnes, ou brancher la
modale de calibration dessus. Estimation **1 j**. Lot : **L01** / **L07**.

### F-148 — P2 — `wiki/API-Reference.md` documente 17 commandes qui n'existent pas

Inexistantes : `routing_set`, `routing_delete`, `routing_list`, `routing_get`,
`auto_assign_suggest`, `auto_assign_apply`, `auto_assign_preview`,
`lighting_list_drivers`, `lighting_set_color`, `bluetooth_scan`,
`bluetooth_pair`, `bluetooth_connect`, `string_get_presets`,
`string_set_tuning`, `bank_list`, `bank_select`, `instrument_voice_select`.
Le total annoncé (« 146 commandes sur 15 modules ») est faux (270 / 26).
`wiki/Home.md` annonce en outre « *Network (RTP-MIDI / **RFC 6295**)* » alors
que le README dit explicitement l'inverse (« *no invitation handshake, clock
synchronisation or journal/recovery* ») et que T4.2 est ouvert.

Le wiki étant présenté comme « *the navigable, top-level entry point* », c'est
la première documentation qu'un intégrateur lit. Estimation **0,5 j**. Lot : **L14**.

### F-149 — P3 — `docs/API.md` : 5 événements fantômes, 84 commandes absentes

Documentés comme événements WS mais **jamais diffusés** :
`file_uploaded`, `midi_message`, `midi_routed`, `playback_started`,
`playback_stopped` — ils n'existent que sur l'EventBus interne
(`Application.js:491-500`). Un client tiers qui s'y abonne n'aura jamais rien
(c'est exactement le bug que l'inline `index.html:7602-7611` documente avoir
corrigé côté SPA). Par ailleurs 84 des 270 commandes ne figurent dans aucun
tableau (`arrangement_*` ×11, `hotspot_*`/`wifi_*` ×10, `instrument_light_*` ×6,
`loop_*` ×5, `tuner_*` ×3, …). Lot : **L14**.

### F-150 — P2 — Canvas V2 est devenu le défaut sans la porte de QA que le plan exigeait

`V0.9_ROADMAP` T4.3 dit « ⏸ **Reporté** post-v0.9 — le V2 reste accessible en
opt-in » et `TODO.md` §Phase C détaille un plan en 5 étapes (setting UI → bêta
2 semaines → bascule → release de patch → suppression de la lib). Réalité :
`?pianoRollV2=1` et `gmboop_piano_roll_v2` n'existent plus,
`public/lib/webaudio-pianoroll-custom.js` a disparu
(`find public -name "*pianoroll*"` = vide), `PianoRollRenderer.js:12` déclare
« *The sole concrete implementation is `CanvasPianoRollRenderer`* » et
`MidiEditorPianoRollBoot.js:56-76` l'instancie sans condition.

Autrement dit : **la suppression a eu lieu, la validation non**. Le pré-requis
écrit — « *Browser test obligatoire — pas faisable en session Claude Code* » —
n'a jamais été levé ; aucune session humaine n'a exercé l'édition réelle
(drag-select dense, copy/paste avec offset, undo/redo profond). Les hacks de
resize que la bascule devait supprimer sont toujours là
(`MidiEditorResize.js:8-11`).

**Correctif** : exécuter la QA rétroactivement — c'est précisément le périmètre
de **L08** (E2E navigateur) et **T9.2**. Mettre à jour les deux roadmaps.

### F-151 — P3 — Les roadmaps et le README **sous-déclarent** trois fonctionnalités livrées

1. `voices_share_notes` est exposé en UI (T1.1(c) déclaré « restant »).
2. Les `handPositionWarnings` d'`apply_assignments` sont câblés (T2.4 déclaré
   « non câblé »).
3. Le README classe « *MIDI-message-driven lighting on instruments and
   peripherals* » en **Planned** alors que la fonctionnalité est livrée :
   migrations 024/027/028/029, `src/lighting/instrument/InstrumentLightCC.js`
   (CC 110-114), `InstrumentLightCommands` (6 cmd), UI dans ISM
   (`ISMListeners.js:2733-2761`) et `LightingControlPage.js:423-636`.

À quoi s'ajoutent deux claims **inexactes** de
`INSTRUMENT_FAMILY_REFACTOR_ROADMAP.md` Phase 0b/0c : le save des voix ne passe
pas par `instrument_voice_replace` (mais par `instrument_update_settings.voices`),
et le program-change de preview vise le synthé navigateur, pas le device.

Impact : le pilotage du projet est faussé dans les deux sens — on croit devoir
faire ce qui est fait, et on ne sait pas ce qui a été livré sans QA. Lot : **L14**.

### F-152 — P2 — Surfaces orphelines résiduelles : lumière temps réel, presets, table morte

- **3 diffusions lumière temps réel sans aucun écouteur** :
  `lighting_device_status` (`LightingManager.js:875`), `lighting_led_state`
  (`:904`), `lighting_effect_change` (`:932`) — et ces deux dernières sont
  **priorisées** dans `WsOutputQueue.js:70-71`. Aucun `api.on()` correspondant
  dans `public/`. Le retour d'état lumière est donc calculé, sérialisé, priorisé
  et jeté. (Idem `device_connected`, `device_disconnected`, `midi_event`.)
- **Sous-système `presets` entièrement orphelin** : 6 commandes, 6 schémas,
  6 testées, table `presets` avec contrainte `CHECK`, **aucune UI**.
- **Table `instrument_light_config` : 33 colonnes, 0 lecteur** (migrations
  025/026, remplacée par `instrument_light_state` en 027 qui documente
  l'abandon). Plus `instruments_latency.midi_clock_enabled` (doublon mort de
  `devices.midi_clock_enabled`, seule lue par `MidiClockGenerator.js:163`),
  `presets.is_favorite`, `sessions.last_opened`, `devices.port_id`.
- **Aucun téléchargement de fichier MIDI dans la SPA** malgré `file_export` et
  `GET /api/files/:id/blob`.

**Correctif** : brancher les 3 diffusions lumière (retour d'état = valeur
opérateur réelle, ~1 j), trancher `presets` (UI ou retrait, ~1 j), planifier une
migration de nettoyage de schéma. Lots : **L02** (lumière), **L07** (schéma),
**L01** (statut des commandes).

### F-153 — P2 — Découvrabilité : trois fonctionnalités mises en avant sont masquées par défaut

`SettingsModal.js:94-95` : `showCalibrationButton: false`,
`showLightingButton: false`. Or :
- le README consacre une section entière à **Lighting** (avec capture d'écran) ;
- il annonce « *including a microphone-based calibration* » ;
- le **wiki a une page dédiée** `Interface-Microphone`.

Et l'**accordeur chromatique** n'est atteignable **que** depuis la modale
Calibration (`CalibrationModal.js:223-232`), elle-même derrière le bouton
masqué : il est donc à deux niveaux d'invisibilité. Un utilisateur qui suit le
README ne trouve aucun de ces écrans.

**Correctif** : décision produit (T8.5). Le minimum honnête est soit d'activer
ces boutons par défaut, soit d'ajouter une mention « à activer dans Réglages »
au README/wiki. Estimation **0,5 j**. Lot : décision produit + **L09**.

### F-154 — P2 — Divergence live ≠ baké non répertoriée : `MidiBaker` ignore les pins de main

`MidiPlayer.js:779-786` honore `hand_position_overrides.note_assignments`
(pins d'opérateur) en passant `noteAssignments` à `HandAssigner.assign()`.
`src/files/MidiBaker.js` construit son `HandPositionPlanner`/`LongitudinalPlanner`
(`:427-428`, `:473`) **sans jamais lire `hand_position_overrides`**
(`grep overrides src/files/MidiBaker.js` = vide). Le même fichier, avec les
mêmes réglages, produit donc des CC de main différents selon qu'il est joué en
direct ou baké — et comme `apply_assignments` **appelle `bakeAndSave`** quand un
routage vise un instrument à `hands_config` (TODO.md §« CC main… — Résolu »),
c'est la version **sans les pins** qui finit dans le fichier et dans l'éditeur CC.

Ceci s'ajoute aux divergences déjà arbitrées de T3 et **n'est listé nulle part**.
À croiser avec **L05** (harnais de rejeu déterministe). Estimation **1-2 j**.

### F-155 — P3 — Le suivi de dette et le CHANGELOG mentent sur l'état du dépôt

- Tailles de fichiers de `TODO.md`/`V0.9_ROADMAP` T7.1 périmées, et **dans le
  mauvais sens** : `MidiPlayer.js` 2061→**3024**, `RoutingSummaryPage.js`
  « ramené à ~2980 »→**3550** (au-dessus de sa taille d'origine),
  `ISMSections.js` 2213→**3028**, `ISMListeners.js` 1830→**2773**,
  `HandPositionFeasibility.js` 1682→**1936**. À l'inverse `LoopCreatorModal.js`
  1944→**853** et `keyboard.css` 252→**124 `!important`** : l'amélioration n'est
  pas tracée non plus.
- `CHANGELOG.md` s'arrête à **0.8.2 (2026-05-17)**. Aucune trace des migrations
  020→034, du descripteur v2, des arrangements, du hotspot, des SF2
  personnalisés, des voix GM, de la gestion de main — soit ~4 mois de
  développement. La section `[Unreleased]` (v6 storage refactor, déjà livré) est
  placée **sous** `[0.7.0]`, à l'intérieur de l'historique « Ma-est-tro ».
- `package.json` = 0.8.1, roadmap et wiki = « v0.8.2 ».

Lot : **L14**.

---

## 6. Liste close de ce qui manque pour la v0.9 — priorisée et chiffrée

**Critère v0.9 rappelé** (`V0.9_ROADMAP.md` §1) : *plus aucune capacité morte,
plus aucune fonctionnalité backend sans surface UI (ou documentée comme
volontairement interne)*.

### Bloc A — bloquants « 100 % fonctionnel » (capacités mortes / promesses cassées)

| # | Ce qui manque | Effort | Lot / chantier |
|---|---|---|---|
| A1 | **Trancher le routage live** : matrice de routage en UI **ou** requalification explicite des 15 commandes en API interne + retrait de la promesse README (F-138) | 5-8 j (UI) ou 0,5 j (doc) — **décision produit d'abord** | UI / L01 |
| A2 | Consommer `hand_anchors` + `disabled_notes` dans le planner, le player **et** le baker (F-139) | 3-5 j | L06 + L05 |
| A3 | Arrêter d'écraser `is_fretless` / `capo_fret` ; exposer ou retirer (F-140) | 1-2 j | L06 + L07 |
| A4 | Filtrer le pitch bend par `pitch_bend_enabled` en playback et en live (F-146) | 0,5 j | L06 |
| A5 | Aligner `MidiBaker` sur `MidiPlayer` pour les pins de main (F-154) | 1-2 j | L05 |
| A6 | Boucle de lecture exposée dans le transport (F-145) | 0,5 j | UI |
| A7 | `validate_routing_feasibility` : câbler le bandeau pré-assignation **ou** supprimer la commande au profit du miroir client (T2.4) | 1 j | UI / L01 |
| A8 | Brancher les 3 diffusions lumière temps réel, ou les retirer (F-152) | 1 j | L02 |
| A9 | Trancher `presets` (6 cmd) et `latency_*` (8 cmd) : UI ou retrait documenté (F-147, F-152) | 1-2 j | L01 |
| A10 | Statuer les **72** commandes orphelines une à une : « interne assumée » / « à câbler » / « à retirer » — c'est le livrable qui ferme littéralement le critère v0.9 | 2 j | **L01** (avec cette matrice en entrée) |
| A11 | T1.8 : persistance + diff du descripteur v2, chemin HTTP, `capabilities_source='descriptor'` (F-143) | 4-6 j | L06 + L07 |
| A12 | T1.1(b) : injection de voix sur le route-through live — **conditionné à A1** (F-144) | 1-2 j | L06 |
| A13 | Persister/relire `behavior_mode` (L06 F-65) — sinon le mode de split choisi est perdu à chaque rechargement | 0,5 j | L06 |
| A14 | Consommer les 5 colonnes par voix d'`instrument_voices` dans `VoiceSelector` (L06 F-70, roadmap familles Phase 8 §4) | 2-3 j | L06 |
| A15 | Brancher `shared/gm-instrument-capabilities.json` (polyphonie/monophonie de famille) ou le retirer (L06 F-73) | 1-2 j | L06 |
| A16 | Gardes de validation sur `octave_mode`/`scale_root` + prise en compte dans le scoring (L06 F-68/F-69) | 1-2 j | L06 + L07 |

**Sous-total bloc A : ~26 à 42 jours** (hors A1 en variante UI).

### Bloc B — périmètre v0.9 arbitré le 2026-08-07, toujours non commencé

| # | Ce qui manque | Effort | Lot |
|---|---|---|---|
| B1 | **T4.1** `independent_fingers` : `IndependentFingersPlanner` greedy, modèle `fingers[]`, encodage CC, levée des 3 verrous **et** des tests qui exigent le rejet | 10-15 j | chantier dédié |
| B2 | **T4.2** journal de récupération RTP-MIDI (RFC 6295) + estimation d'offset d'horloge | 10-15 j | chantier dédié |

> Ces deux items sont, à eux seuls, **plus lourds que tout le bloc A**. Si la
> v0.9 doit sortir à échéance courte, l'arbitrage du 2026-08-07 est à
> **ré-ouvrir** : le README annonce déjà RTP-MIDI comme *experimental* et
> `independent_fingers` comme grisé — les reporter ne casse aucune promesse.

### Bloc C — contrat et documentation (promesses écrites non tenues)

| # | Ce qui manque | Effort | Lot |
|---|---|---|---|
| C1 | Schémas de payload : atteindre au minimum le critère ADR-004 (playback + routing à 100 %), et **fermer le fail-open** ou l'assumer par écrit (F-142) | 4-6 j | L01 |
| C2 | Versionnement WS : implémenter le lookup **ou** corriger `CommandRegistry`, `CLAUDE.md` et ADR-003 (F-141) | 0,5-2 j | L01 / L14 |
| C3 | `wiki/API-Reference.md` : 17 commandes fantômes, total faux, « RFC 6295 » (F-148) | 0,5 j | L14 |
| C4 | `docs/API.md` : retirer les 5 événements fantômes, documenter 84 commandes (F-149) | 1-2 j | L14 |
| C5 | README : passer la lumière embarquée de *Planned* à livré ; mentionner que Lumière/Calibration sont masqués par défaut (F-151, F-153) | 0,5 j | L14 |
| C6 | Réconcilier `V0.9_ROADMAP`, `INSTRUMENT_FAMILY_REFACTOR_ROADMAP` et `TODO.md` (Phase 8 vs T1.1, T4.3, T1.1c, T2.4, chiffres de dette) (F-150, F-151, F-155) | 1 j | L14 |
| C7 | `CHANGELOG.md` : 4 mois manquants, section `[Unreleased]` mal placée, version 0.8.1 vs 0.8.2 (F-155) | 1 j | L14 |

**Sous-total bloc C : ~9 à 13 jours.**

### Bloc D — validation qui conditionne la confiance (ne peut pas être sautée)

| # | Ce qui manque | Effort | Lot |
|---|---|---|---|
| D1 | QA navigateur de l'éditeur MIDI, **rétroactive** car Canvas V2 est déjà le défaut sans validation (F-150) | inclus | **L08** |
| D2 | Tests lumière (0 % de couverture sur ~1 785 statements pilotant du réseau/GPIO) | inclus | **L02** |
| D3 | QA matérielle : USB/BLE/UART/audio/orchestre | — | **L15** (procédure) puis humain |
| D4 | Décisions produit à obtenir de l'utilisateur : A1 (routage live), T8.5 (boutons masqués), B1/B2 (périmètre v0.9), `capo_fret` | — | — |

---

## 7. Verdict — « le système est-il complet et fonctionnel comme prévu ? »

**Non. Il en est proche, mais pas au sens que le projet s'est lui-même donné.**

**Ce qui est vrai et mérite d'être dit.** Le cœur musical tient ses promesses.
L'analyse de canal, le scoring d'instruments, le split, la transposition, le
repli de plage, le remappage de batterie, la réduction de polyphonie, la
compensation de latence, l'éditeur multi-vues, les 16 claviers virtuels
spécialisés, les boucles et l'arrangeur, le SF2 par instrument, la planification
de main pour les instruments mécanisés : tout cela existe, est atteignable
depuis l'interface, est couvert par 1 875 tests backend et 1 488 tests frontend,
et produit un effet réel et vérifiable. Sur les 270 commandes, **198 sont
réellement atteignables** — pas 147 comme le laissait croire l'outil d'audit.
La v0.9 n'est pas un mirage : c'est un projet mûr à qui il manque une passe de
fermeture.

**Ce qui empêche de dire « complet ».** Trois choses, par ordre de gravité.

**1. Un sous-système entier est inatteignable.** Le routage MIDI live —
`MidiRouter`, 895 lignes, 15 commandes, 8 schémas, 6 suites de tests, documenté
dans `docs/API.md` — **n'a aucune porte d'entrée dans l'interface**. On ne peut
pas créer une route depuis la SPA. Ce n'est pas un détail : c'est le mécanisme
qui fait qu'un contrôleur MIDI branché en USB ou en Bluetooth pilote un
instrument DIY. Le README promet que « *les notes BLE entrantes sont routées
comme n'importe quelle autre entrée* » ; avec zéro route, elles ne vont qu'au
moniteur de debug. Tout le travail fait sur ce chemin (le gate de polyphonie
live de T1.5, le clamp de capacités, le correctif L06 F-64) porte sur du code
qu'un utilisateur ne peut pas déclencher. **Soit on livre la matrice de
routage, soit on retire la promesse.** Il n'y a pas de troisième option
honnête.

**2. Trois réglages que l'utilisateur manipule n'ont aucun effet.** C'est
exactement la « capacité morte » que la définition v0.9 interdit :
- On **fait glisser la bande de main** dans l'éditeur, on **épingle un ancrage**,
  on **désactive une note** ; l'écran répond, la base enregistre, la simulation
  cliente en tient compte — et le moteur de lecture ne les lit jamais.
- On configure un **violoncelle fretless** via un preset, puis on ouvre et
  ferme le modal Réglages : le drapeau `is_fretless`, que trois modules du
  moteur consomment, est **remis à zéro en dur** par le chemin de sauvegarde.
- On décoche **pitch bend** sur un instrument mécanique : la molette du clavier
  virtuel disparaît, mais la lecture d'un fichier lui envoie quand même les
  messages de pitch bend.

Ces trois-là sont les vrais blockers. Ils sont peu coûteux à fermer (4 à 8
jours au total) et ce sont ceux que l'utilisateur ressent.

**3. La carte ne correspond plus au terrain.** Le pilotage du projet s'est
désynchronisé du code, dans les deux sens. La roadmap v0.9 dit que le piano
roll Canvas V2 est « reporté, opt-in » : il est en réalité **le seul renderer**,
la bibliothèque tierce a été supprimée, et la porte de validation que le plan
exigeait (bêta de deux semaines, QA navigateur obligatoire) **n'a jamais été
franchie** — on a fait la suppression sans faire la vérification. À l'inverse,
la roadmap réclame encore trois choses déjà livrées. Le wiki, présenté comme la
porte d'entrée du projet, documente **17 commandes qui n'existent pas** et
annonce une conformité RFC 6295 que le README dément dans le même dépôt. ADR-003
décrit un versionnement de contrat que le dispatcher n'implémente pas, et
ADR-004 fixe un critère de sortie (100 % des commandes playback et routing
schématisées) atteint à 35 % et 38 %. Le CHANGELOG s'arrête en mai, quatre mois
et quinze migrations en arrière. Et les chiffres de dette technique cités dans
`TODO.md` sont périmés dans le mauvais sens : `MidiPlayer.js` est passé de 2 061
à 3 024 lignes, `RoutingSummaryPage.js` de « ramené à 2 980 » à 3 550.

**Le chiffre à retenir.** Sur les 270 commandes WebSocket, **72 n'ont aucune
surface UI** — pas 123 comme mesuré jusqu'ici, l'outil d'audit ne lisant pas les
8 100 lignes de JavaScript inline de `index.html`. Ces 72 se concentrent sur
cinq blocs cohérents : le routage live (15), les fichiers (8), la latence (8),
les presets (6), les voix d'instrument (4). **Aucune n'a été explicitement
statuée « interne » comme le critère v0.9 l'autorise.** Tant que ce statut n'est
pas posé, ligne par ligne, le critère « plus aucune fonctionnalité backend sans
surface UI » ne peut pas être déclaré satisfait — indépendamment de tout
correctif.

**Combien de travail.** Environ **26 à 42 jours** pour fermer les blockers
fonctionnels, **9 à 13 jours** pour remettre le contrat et la documentation en
accord avec le code, plus les lots de validation L02 et L08 qui tournent en
parallèle. Les deux gros chantiers retenus le 2026-08-07 pour la v0.9 —
`independent_fingers` et le journal RTP-MIDI — pèsent à eux seuls **20 à 30
jours** et sont, dans les deux cas, déjà annoncés comme non disponibles à
l'utilisateur (carte grisée, transport « experimental »). **Recommandation :
les sortir du périmètre v0.9.** Sans eux, une v0.9 réellement « 100 %
fonctionnelle » est à environ **six à huit semaines** de travail, dont la moitié
est de la fermeture d'écarts déjà identifiés ici.

---

## 8. Ce que les autres lots doivent reprendre de ce rapport

| Lot | À reprendre |
|---|---|
| **L01** | Le chiffre corrigé (**72** orphelines, pas 123) et sa cause (`command-inventory.mjs` ignore `index.html`) ; la ventilation par module du §2 ; A10 (statuer les 72) ; F-141, F-142, F-147, F-152 |
| **L02** | F-152 (3 diffusions lumière sans écouteur, priorisées dans `WsOutputQueue`) ; `lighting_scene_apply`/`lighting_led_broadcast` orphelines ; commentaire périmé `LightingCommands.js:277` |
| **L05** | F-154 (`MidiBaker` ignore les pins de main) et `min_note_duration` playback-only : deux divergences live ≠ baké à mesurer avec le harnais de rejeu |
| **L06** | F-139, F-140 (l'écrasement de `is_fretless`/`capo_fret` par `ISMSave.js:266-267` **n'est pas dans son rapport**), F-154 ; réciproquement ce lot reprend ses F-65, F-68/69, F-70, F-72, F-73 dans sa matrice (§2.3) et sa liste close (A13→A16) |
| **L07** | F-140 (intégrité `is_fretless`), T5.1 (atomicité), migration de nettoyage (`instrument_light_config` 33 colonnes, `instruments_latency.midi_clock_enabled`, `presets.is_favorite`, `sessions.last_opened`, `devices.port_id`), rebuild `CHECK` pour `'descriptor'` |
| **L08** | F-150 — la QA du piano roll n'est plus optionnelle : le V2 est **déjà** le défaut sans avoir été validé |
| **L09** | F-153 (découvrabilité) ; la mesure i18n par locale du §2.8 (68→88 %) |
| **L14** | F-148, F-149, F-151, F-155 — et le tableau §4 des items cochés à tort |

---

*Rapport produit sans modification de code. Toutes les affirmations portent leur
fichier et leur ligne, ou constatent explicitement l'absence. Les mesures
d'inventaire sont reproductibles avec `scripts/audit/command-inventory.mjs
--json` complété du scan incluant `public/index.html` décrit en §1.2.*
