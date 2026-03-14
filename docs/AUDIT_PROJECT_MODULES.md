# Audit des Modules Prioritaires - MidiMind v5.0.0

**Date** : 2026-03-14
**Modules audités** : 1, 4, 8, 9, 15, 22, 24, 26, 28
**Fichiers analysés** : ~80 fichiers

---

## Table des matières

1. [Synthèse exécutive](#synthèse-exécutive)
2. [Module 1 - MIDI Core : Routing & Playback](#module-1---midi-core--routing--playback)
3. [Module 4 - Latence & Calibration](#module-4---latence--calibration)
4. [Module 8 - Storage Database](#module-8---storage-database)
5. [Module 9 - Storage Fichiers](#module-9---storage-fichiers)
6. [Module 15 - InstrumentManagementPage](#module-15---instrumentmanagementpage)
7. [Module 22 - Utils Frontend](#module-22---utils-frontend)
8. [Module 24 - Migrations DB](#module-24---migrations-db)
9. [Module 26 - CSS / Thèmes](#module-26---css--thèmes)
10. [Module 28 - Configuration](#module-28---configuration)
11. [Problèmes transversaux](#problèmes-transversaux)
12. [Plan de correction prioritaire](#plan-de-correction-prioritaire)

---

## Synthèse exécutive

### Statistiques globales

| Sévérité | Nombre |
|----------|--------|
| **Critiques** (bugs, crashes, sécurité) | 28 |
| **Importants** (robustesse, performance) | 52 |
| **Mineurs** (style, cohérence) | 38 |

### Top 10 des problèmes les plus urgents

| # | Sévérité | Module | Problème |
|---|----------|--------|----------|
| 1 | CRITIQUE | 15 | XSS systémique dans InstrumentManagementPage - `escapeHtml()` existe mais n'est pas utilisé |
| 2 | CRITIQUE | 24/8 | Schéma `routes` incompatible entre migration 008 et le code JS |
| 3 | CRITIQUE | 24/8 | Deux tables de latence (`instruments_latency` vs `instrument_latency`) coexistent |
| 4 | CRITIQUE | 22 | Boucle infinie dans MidiParser.readVariableLength sur fichiers corrompus |
| 5 | CRITIQUE | 26 | Conflits de variables CSS `:root` entre 4+ fichiers (résultat imprévisible) |
| 6 | CRITIQUE | 1 | Race condition dans MidiPlayer.seek() + flash position à 0 |
| 7 | CRITIQUE | 4 | Parsing ALSA français-only dans DelayCalibrator (inutilisable en anglais) |
| 8 | CRITIQUE | 22 | Corruption d'état dans MoveNotesCommand (undo/redo incohérent) |
| 9 | CRITIQUE | 24 | FOREIGN KEY dans ALTER TABLE ignorée par SQLite (migration 016) |
| 10 | CRITIQUE | 26 | 362 `!important` dans les CSS (guerre de spécificité) |

---

## Module 1 - MIDI Core : Routing & Playback

### MidiRouter.js (250 lignes) - Complexité : moyenne

#### Problèmes critiques

- **[ligne 246]** `substr()` est deprecated (legacy ECMAScript). Utiliser `substring(2, 11)`.
- **[ligne 9]** `loadRoutesFromDB()` asynchrone dans le constructeur - si la DB n'est pas prête, le routeur démarre vide sans avertissement.

#### Problèmes importants

- **[ligne 38-63]** `addRoute` : les paramètres `source` et `destination` ne sont jamais validés. Des routes avec `null` seront enregistrées en DB.
- **[ligne 52-59]** `insertRoute` pas dans un try/catch. Si l'insertion DB échoue, la route reste en mémoire (Map) mais pas en DB → inconsistance.
- **[ligne 71-72]** `deleteRoute` : suppression de la Map AVANT l'appel DB. Si la DB échoue, la route est perdue en mémoire mais persiste en DB.
- **[ligne 113-148]** `routeMessage` : itération sur TOUTES les routes pour chaque message MIDI. Goulot d'étranglement potentiel à haute fréquence. Un index par `source` serait plus performant.
- **[ligne 128-132]** Si `sendMessage()` lève une exception (device déconnecté), le forEach s'interrompt et les routes suivantes ne sont pas traitées.
- **[ligne 87-97]** `setFilter` : aucune validation du paramètre `filter`. `Object.keys(null)` crashe.
- **[ligne 174-178]** `passesFilter` noteRange : comparaison avec `undefined` donne `false`, laissant passer des notes inattendues.

#### Points positifs
- Gestion d'erreurs individuelles lors du chargement des routes DB.
- Le channel mapping avec spread operator préserve l'immutabilité.

---

### MidiPlayer.js (701 lignes) - Complexité : élevée

#### Problèmes critiques

- **[ligne 362-378]** **Race condition dans `seek()`** : `stop()` puis `start()` cause un broadcast de position=0 au client (flash visuel), suivi immédiatement par la bonne position.
- **[ligne 413-414]** `Date.now()` peut sauter (NTP adjustment, suspension système). Sur Raspberry Pi, les ajustements NTP sont fréquents après le boot → sauts de position soudains.
- **[ligne 417-423]** Boucle avec loop : `seek(0)` appelle `stop()` + `start()`, créant un nouveau setInterval tandis que l'ancien `tick()` pourrait être encore en queue.
- **[ligne 490]** Perte de précision temporelle : `Date.now()` a ~1ms de résolution. `performance.now()` serait plus adapté pour la compensation de latence.

#### Problèmes importants

- **[ligne 46]** `Buffer.from(file.data, 'base64')` : si la data n'est pas du base64 valide, produit un buffer corrompu silencieusement.
- **[ligne 88-98]** `extractTempo` ne prend que le PREMIER événement de tempo. `this.tempo` dans `getStatus()` est trompeur pour les fichiers multi-tempo.
- **[ligne 380-387]** `findEventIndexAtTime` : recherche linéaire O(n). Une recherche binaire serait plus performante pour les gros fichiers.
- **[ligne 473-497]** Double lookup `getOutputForChannel` (au scheduling ET à l'exécution). Si le routing change entre-temps, incohérence.
- **[ligne 556-579]** `sendAllNotesOff` : les erreurs de `sendMessage` ne sont pas catchées. Un device déconnecté fait échouer tout le cleanup.

#### Points positifs
- Tempo map multi-tempo bien implémenté (`_buildTempoMap`, `_ticksToSecondsWithTempoMap`).
- Cache syncDelay évitant les requêtes DB répétées.
- Cleanup des timeouts pendants dans `stopScheduler()`.
- NoteOn velocity=0 traité comme noteOff (conforme spec MIDI).

---

### MidiMessage.js (350 lignes) - Complexité : moyenne

#### Problèmes critiques

- **[ligne 318]** `this.type.toUpperCase()` crashe si `this.type` est `null` (valeur initiale non modifiée si `parseSystemMessage` ne matche rien).
- **[ligne 104]** Status bytes `0xF4`, `0xF5`, `0xF9`, `0xFD` laissent `type = null`.

#### Problèmes importants

- **[ligne 27-83]** `parseBytes` : aucune vérification de longueur. Si le tableau ne contient qu'un octet, `bytes[1]` et `bytes[2]` seront `undefined`.
- **[ligne 86-96]** `parseObject` : **injection de propriétés** possible via `Object.keys(obj).forEach(key => { this[key] = obj[key]; })`. Un objet malicieux pourrait écraser des méthodes de l'instance.
- **[ligne 248-253]** `validate()` pour poly aftertouch valide `pressure` mais PAS `note` (qui est aussi requis).
- **[ligne 217]** `validate()` ne vérifie pas que `this.type` est non-null.

---

## Module 4 - Latence & Calibration

### LatencyCompensator.js (293 lignes) - Complexité : moyenne

#### Problèmes critiques

- **[ligne 120-135]** Faux positifs de mesure : le handler écoute les événements `midi_message` globaux. Un autre device envoyant un noteOn C4 pendant la calibration faussera la mesure.
- **[ligne 109-162]** Fuite potentielle du handler si `measureSingleRoundtrip` est interrompue.

#### Problèmes importants

- **[ligne 42-107]** Le verrou `calibrationInProgress` est à granularité de l'instance, empêchant la calibration parallèle même pour des devices différents.
- **[ligne 25-35]** `new Date(profile.last_calibrated)` peut produire `Invalid Date` si la DB est corrompue → `shouldRecalibrate` retournera `NaN`, le device ne sera JAMAIS recommandé pour recalibration.
- **[ligne 16]** `this.pendingMeasurements` est initialisé mais **jamais utilisé**. Code mort.

---

### DelayCalibrator.js (369 lignes) - Complexité : moyenne

#### Problèmes critiques

- **[ligne 333]** **Parsing ALSA français uniquement** : regex `carte (\d+):.*peripherique (\d+):` ne matche que la sortie française de `arecord -l`. Sur un système en anglais → aucun device détecté.
- **[ligne 271]** Mesure imprécise : polling toutes les 10ms → erreur de 0-10ms. Significatif pour un calibrateur de latence.
- **[ligne 285-306]** Si `buffer.length` est impair, `readInt16LE` lèvera une `RangeError`.
- **[ligne 93]** Calcul de médiane incorrect pour nombre pair de mesures : retourne l'élément du milieu au lieu de la moyenne des deux éléments centraux.

#### Problèmes importants

- **[ligne 206-213]** `stopRecording` envoie SIGTERM mais n'attend pas la fin du processus. Conflit possible sur le device ALSA si la mesure suivante démarre immédiatement.
- **[ligne 175-181]** `this.config.alsaDevice` passé directement à spawn (risque limité car spawn utilise un tableau d'arguments).
- **[ligne 184-188]** Accumulation mémoire non bornée sur `this.audioBuffer`.

#### Problème transversal Latence

| Aspect | LatencyCompensator | DelayCalibrator |
|--------|-------------------|-----------------|
| Constructeur | `app` (standard) | `midiController, logger` (non-standard) |
| API timing | `process.hrtime.bigint()` | `performance.now()` |
| Velocity test | 64 | 100 |
| Durée note test | 50ms | 500ms |

→ Deux modules de calibration avec des APIs et paramètres incompatibles.

---

## Module 8 - Storage Database

### Database.js (510 lignes)

#### Problèmes critiques

- **[ligne 108]** Transaction manuelle (`db.exec('BEGIN TRANSACTION')`) au lieu de `db.transaction()`. Les opérations DDL (CREATE TABLE) ne sont pas transactionnelles en SQLite → état incohérent possible si une migration échoue partiellement.
- **[lignes 57-64]** **Système de migration DOUBLE** : le code JS utilise la table `migrations`, les fichiers SQL écrivent dans `schema_version`. Les deux systèmes coexistent sans synchronisation.
- **[ligne 77]** `parseInt(file.split('_')[0])` retourne `NaN` pour un fichier non-conventionnel.

#### Problèmes importants

- **[ligne 472-479]** `backup()` retourne une Promise mais n'est pas async et ne fait pas de await → l'appelant ne sait jamais si le backup a réussi.
- **[lignes 492-507]** `getStats()` crashe si une table n'existe pas encore.
- **[lignes 210-251]** `updateRoute` : noms de colonnes non validés par whitelist (pas de risque SQL injection grâce aux prepared statements, mais erreurs silencieuses).

---

### MidiDatabase.js (655 lignes)

#### Problèmes critiques

- **[lignes 337-353]** Mode `EXACT` dans `filterFiles` identique au mode `ALL` → bug fonctionnel.
- **[lignes 339-341]** Recherche instrument_types via `LIKE '%"type"%'` : "Piano" matche aussi "Electric Piano".

#### Problèmes importants

- **[lignes 69-77]** `getAllFiles()` charge TOUS les fichiers incluant la colonne `data` (BLOB base64). Consommation mémoire excessive pour une grande collection.
- **[ligne 177]** `searchFiles` : les caractères `%` et `_` dans la query sont interprétés comme wildcards LIKE.

---

### InstrumentDatabase.js (1022 lignes)

#### Problèmes critiques

- **[lignes 148-196]** **Deux tables de latence** : `saveLatencyProfile` utilise `instrument_latency` (singulier) tandis que le reste utilise `instruments_latency` (pluriel). Schémas différents, données séparées.
- **[ligne 669]** `supportedCcsJson` initialisée à `null`, comparée à `undefined` → condition toujours vraie → écrasement involontaire des valeurs existantes.

#### Problèmes importants

- **[lignes 334-416]** Pattern check-then-insert/update sans transaction. Doublons possibles.
- **[lignes 941-982]** `insertRouting` : si `channel` est NULL, l'upsert conditionnel ne fonctionne pas → doublons.
- **[ligne 1004-1006]** `getRoutingsByFile` retourne `[]` en cas d'erreur au lieu de lever l'exception. Échec silencieux.

---

## Module 9 - Storage Fichiers

### FileManager.js (796 lignes)

#### Problèmes critiques

- **[lignes 78-109]** `extractMetadata` ne gère que le PREMIER événement de tempo. Durée incorrecte pour les fichiers multi-tempo.

#### Problèmes importants

- **[ligne 19]** Aucune validation de taille avant `Buffer.from(base64Data, 'base64')`. Un fichier de plusieurs centaines de Mo causerait un OOM.
- **[lignes 36-47]** Stockage du fichier MIDI complet en base64 dans la DB → scalabilité limitée.
- **[ligne 560-563]** `duplicateFile` : si le fichier n'a pas d'extension, le nom sera corrompu.
- **[lignes 750-793]** `reanalyzeAllFiles` charge TOUS les fichiers (y compris les données base64) en mémoire.

### JsonMidiConverter.js (281 lignes)

#### Problèmes importants

- **[lignes 167-196]** Même bug mono-tempo que FileManager et MidiParser.
- **[lignes 121-148]** Meta-événements cherchés uniquement dans la piste 0 → incorrect pour format 2.

---

## Module 15 - InstrumentManagementPage

### InstrumentManagementPage.js (589 lignes) - Complexité : élevée

#### Problèmes critiques

- **[ligne 255]** **XSS** : `displayName` (données utilisateur/réseau) injecté dans innerHTML sans `escapeHtml()`. Un nom d'instrument malveillant (`<img onerror=alert(1) src=x>`) exécutera du JavaScript.
- **[ligne 285-298]** **XSS** : `instrument.id` interpolé dans des attributs `onclick` sans échappement.
- **[ligne 543]** **XSS** : `message` injecté dans innerHTML du toast (peut contenir des données serveur comme `error.message`).
- **[ligne 563]** **XSS** : `message` dans `showError` injecté via innerHTML sans échappement.

#### Problèmes importants

- **[ligne 128-139]** Requêtes API séquentielles N+1 : une requête par instrument dans une boucle `for...of` avec `await`.
- **[ligne 111]** Fuite DOM si `show()` est appelé plusieurs fois sans `close()`.
- **[ligne 575-583]** Nettoyage incomplet dans `close()` : timers et listeners non nettoyés.
- **[ligne 461]** Dépendance implicite à `window.showConfirm` sans vérification.

---

## Module 22 - Utils Frontend

### MidiParser.js (538 lignes) - Complexité : élevée

#### Problèmes critiques

- **[ligne 287-298]** **Boucle infinie** dans `readVariableLength` si le fichier MIDI est corrompu (chaque octet avec bit 0x80). La spec MIDI limite à 4 octets → aucune garde implémentée.
- **[ligne 147]** **Boucle infinie** dans `parseTrack` si un événement mal formé retourne `bytesRead = 0`.

#### Problèmes importants

- **[ligne 157-158]** Running status mis à jour pour les meta-events et SysEx (ne devrait pas l'être selon la spec). Peut corrompre le parsing.
- **[ligne 502-516]** Calcul de durée utilise un seul tempo. Ironiquement, `extractTempoChanges` collecte tous les changements mais n'est pas utilisée ici.
- **[ligne 53-62]** Pas de validation de taille minimale du buffer ni de vérification de dépassement.

---

### CommandHistory.js (386 lignes) - Complexité : moyenne

#### Problèmes critiques

- **[ligne 130-144]** **Corruption d'état** dans `MoveNotesCommand.execute` : mute `this.notes` (la copie de référence). Après undo/redo/undo, les coordonnées de recherche ne correspondent plus aux notes réelles.

#### Problèmes importants

- **[ligne 50-51]** Recherche par égalité `(t, n, c)` peut trouver la mauvaise note s'il existe des notes identiques (accords répétés). Besoin d'identifiants uniques.
- **[ligne 82-88]** `DeleteNotesCommand.execute` : `splice` dans un `forEach` décale les indices des éléments suivants.
- **[ligne 194-196]** `ChangeChannelCommand.undo` ne peut plus distinguer les notes après changement vers le même canal.

---

### FilterManager.js (634 lignes) - Complexité : moyenne

#### Problèmes importants

- **[ligne 23]** Fuite mémoire : timers de debounce non nettoyés (pas de méthode `destroy()`).
- **[ligne 484-491]** Copies superficielles des presets : les tableaux sont partagés par référence. Modifier les filtres courants corrompt le preset.
- **[ligne 356]** `file.folder.startsWith()` crashe si `file.folder` est null/undefined.
- **[ligne 563-567]** `applyQuickFilter` déclenche 3 notifications `onFilterChange` au lieu d'une → 3 re-renders.

---

### escapeHtml.js (12 lignes) - Complexité : faible

- **[ligne 6]** `escapeHtml(0)` retourne `''` au lieu de `'0'` (coercion via `if (!text)`).
- Note : **cette fonction existe mais n'est PAS utilisée dans InstrumentManagementPage.js**, qui est le fichier avec le plus de vulnérabilités XSS.

---

## Module 24 - Migrations DB

### Analyse transversale

**Migrations présentes** : 001, 005, 006, 007, 008, 012, 013, 014, 015, 016, 017, 018, 019, 020
**Gaps** : 002-004, 009-011 (supprimées ou jamais créées)

### Problèmes critiques

| Migration | Problème |
|-----------|----------|
| 008 | Table `routes` avec colonnes `from_device/to_device` incompatibles avec le code JS qui utilise `source_device/destination_device` |
| 005 + 008 | Deux tables de latence : `instruments_latency` (005, riche) et `instrument_latency` (008, simplifiée) |
| 006 + 008 | Deux tables de fichiers : `midi_files` (006) et `files` (008). Seule `midi_files` est utilisée |
| 016 | `REFERENCES` dans `ALTER TABLE ADD COLUMN` est parsée mais **ignorée** par SQLite → `parent_file_id` n'a PAS de cascade fonctionnelle |
| 012 | `DROP TABLE midi_files` + rename : si la copie échoue, toutes les données sont perdues |

### Problèmes importants

| Migration | Problème |
|-----------|----------|
| 001 | Le mécanisme de détection "already applied" ne stoppe pas l'exécution du script |
| 001 | Index `idx_settings_key` sur PRIMARY KEY → redondant |
| 001 | Triggers `AFTER UPDATE` qui font un `UPDATE` sur la même table → anti-pattern |
| 006 | `UNIQUE(midi_file_id, track_id)` vs code JS qui utilise `ON CONFLICT(midi_file_id, channel)` |
| 007 | Types temporels `INTEGER` mais le code JS envoie des ISO strings |
| 012 | `UNIQUE(filename)` empêche deux fichiers du même nom dans des dossiers différents |
| 017 | Index sur colonne JSON TEXT → inutile pour les requêtes LIKE |

---

## Module 26 - CSS / Thèmes

### Statistiques

- **27 fichiers CSS**, **~17 285 lignes** totales
- **362 occurrences de `!important`** (1 pour 48 lignes)
- **23 occurrences de `outline: none`** sans alternative (violations WCAG 2.4.7)
- **6+ redéfinitions** de `@keyframes spin`, `fadeIn`, `slideIn`, `pulse`

### Problèmes critiques

| Fichier | Problème |
|---------|----------|
| themes.css vs main.css | Variables `:root` définissent des thèmes contradictoires (clair vs sombre). Résultat dépend de l'ordre de chargement |
| components.css vs main.css | `.card`, `.btn`, `.notification` redéfinis avec des styles incompatibles |
| themes.css [ligne 510] | `* { transition: ... }` sur TOUS les éléments → performance catastrophique |
| bluetooth/network-scan-modal.css | 148 `!important` combinés → guerre de spécificité |
| editor.css vs main.css | `@keyframes slideIn` redéfini avec des animations différentes sous le même nom |

### Triple système de theming incohérent

1. `body.dark-mode` (classes CSS)
2. `body[data-theme]` (attributs data)
3. `@media (prefers-color-scheme)` (media queries)

### Fichiers utilisant des couleurs en dur (incompatibles dark mode)

- `midi.css` : `#667eea`, `white`, `#2c3e50`
- `instruments.css` : `white`, `#333`, `#f8f9fa` (dark mode = 4 lignes sur 1397)
- `playlist.css` : `white`, `#2c3e50`, `#e9ecef`
- `components.css` : `white` au lieu de `var(--bg-secondary)`

### Accessibilité

- `main.css [ligne 387]` : `outline: none` sur les inputs focus sans alternative visible
- `body [ligne 108]` : `font-size: 14px` en dur (devrait être en `rem` pour respecter le zoom navigateur)
- Seuls `editor-phase2.css` et `editor-notifications.css` implémentent correctement les focus states

---

## Module 28 - Configuration

### Config.js (156 lignes)

#### Problèmes critiques

- **[ligne 88-101]** `set()` n'a **aucune validation** des valeurs. `config.set('server.port', -1)` ou `config.set('database.path', '/etc/passwd')` sont acceptés.
- **[ligne 103-111]** `save()` écrit directement sans vérification → corruption possible.

#### Problèmes importants

- **[ligne 119]** `getAll()` retourne un shallow spread. Les objets imbriqués restent des références → mutation involontaire possible.
- **[ligne 17-28]** Fichier JSON invalide silencieusement remplacé par les défauts (seulement `console.error`).
- **[lignes 31-70]** Duplication config.json / `getDefaultConfig()` → désynchronisation probable.

### config.json

- **[ligne 3-4]** `port` et `wsPort` identiques (8080) mais séparés → trompeur.
- **[ligne 14]** Chemins relatifs (`./data/`, `./logs/`) → fragiles avec PM2.

### ecosystem.config.cjs

- **[ligne 13]** PORT en dur, non synchronisé avec config.json.
- **[ligne 12]** Pas de section `env_development` ou `env_staging`.

---

## Problèmes transversaux

### 1. Incohérence des APIs de timing

| Module | API utilisée |
|--------|-------------|
| MidiPlayer | `Date.now()` |
| LatencyCompensator | `process.hrtime.bigint()` |
| DelayCalibrator | `performance.now()` |

→ Pour un projet manipulant la latence MIDI, une seule API haute résolution devrait être utilisée partout.

### 2. Bug mono-tempo systémique

`extractMetadata` (FileManager), `calculateDuration` (MidiParser, JsonMidiConverter) utilisent tous un seul tempo. Ce bug est dupliqué dans 3 fichiers indépendants.

### 3. Deux systèmes de suivi de migrations

- Table `migrations` (Database.js) — utilisée par le code
- Table `schema_version` (fichiers SQL) — jamais lue par le code

### 4. Schéma DB fragmenté

- 2 tables de routes (schémas incompatibles)
- 2 tables de latence (noms au singulier/pluriel)
- 2 tables de fichiers (une orpheline)

### 5. Gestion d'erreurs DB inconsistante

Certaines opérations DB sont dans des try/catch, d'autres non. Certaines méthodes lèvent des exceptions, d'autres retournent `{ success: false }` ou `[]`.

---

## Plan de correction prioritaire

### Priorité 1 - Sécurité (immédiat)

- [ ] **P1-01** : Appliquer `escapeHtml()` dans InstrumentManagementPage sur tous les `innerHTML` avec données dynamiques
- [ ] **P1-02** : Valider les entrées dans `Config.set()` avec schéma de validation
- [ ] **P1-03** : Protéger `MidiMessage.parseObject()` contre l'injection de propriétés (whitelist)

### Priorité 2 - Stabilité (court terme)

- [ ] **P2-01** : Ajouter garde `bytesRead <= 4` dans MidiParser.readVariableLength
- [ ] **P2-02** : Ajouter garde `event.bytesRead > 0` dans MidiParser.parseTrack
- [ ] **P2-03** : Corriger le bug de la médiane dans DelayCalibrator (nombre pair)
- [ ] **P2-04** : Rendre le parsing ALSA multilingue dans DelayCalibrator (`card|carte`)
- [ ] **P2-05** : Corriger la corruption d'état dans MoveNotesCommand (préserver les coordonnées originales immutablement)
- [ ] **P2-06** : Unifier les tables de latence (`instrument_latency` vs `instruments_latency`)
- [ ] **P2-07** : Corriger le bug `undefined` vs `null` dans InstrumentDatabase.updateInstrumentCapabilities
- [ ] **P2-08** : Corriger le mode EXACT dans MidiDatabase.filterFiles
- [ ] **P2-09** : Encapsuler `insertRoute` dans un try/catch (MidiRouter)
- [ ] **P2-10** : Corriger l'ordre des opérations dans `deleteRoute` (DB avant Map)

### Priorité 3 - Performance & Robustesse (moyen terme)

- [ ] **P3-01** : Indexer les routes par source dans MidiRouter pour éviter l'itération complète
- [ ] **P3-02** : Exclure la colonne `data` de `getAllFiles()` par défaut
- [ ] **P3-03** : Ajouter validation de taille avant `Buffer.from(base64Data)` dans FileManager
- [ ] **P3-04** : Batch les requêtes `instrument_get_capabilities` dans InstrumentManagementPage
- [ ] **P3-05** : Utiliser des copies profondes pour les presets dans FilterManager
- [ ] **P3-06** : Implémenter `performance.now()` partout au lieu de `Date.now()`
- [ ] **P3-07** : Corriger le calcul de durée multi-tempo (3 fichiers impactés)

### Priorité 4 - CSS / Architecture (long terme)

- [ ] **P4-01** : Créer un fichier unique `variables.css` chargé en premier, supprimer les redéfinitions `:root`
- [ ] **P4-02** : Créer un fichier unique `base-components.css` pour `.btn`, `.card`, `.modal`, `.notification`, `.spinner`
- [ ] **P4-03** : Choisir UN mécanisme de theming (recommandé : variables CSS + `body.dark-mode`)
- [ ] **P4-04** : Supprimer la transition `*` globale dans themes.css
- [ ] **P4-05** : Remplacer `outline: none` par des focus states accessibles (WCAG 2.4.7)
- [ ] **P4-06** : Éliminer les `!important` en restructurant les sélecteurs
- [ ] **P4-07** : Convertir les couleurs en dur en variables CSS (midi.css, instruments.css, playlist.css)
- [ ] **P4-08** : Unifier les schémas DB (supprimer tables orphelines, résoudre conflits de nommage)
- [ ] **P4-09** : Unifier le système de suivi de migrations (supprimer `schema_version`)
