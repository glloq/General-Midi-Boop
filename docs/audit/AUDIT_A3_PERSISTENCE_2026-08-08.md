# Audit A3 — Persistance & migrations (2026-08-08)

Audit adversarial (4 relecteurs parallèles) de la couche persistance : les 34
migrations + le runner (`DatabaseLifecycle`), le cœur DB + sauvegardes
(`Database`, `dbHelpers`, `BackupScheduler`), et les 17 gestionnaires de tables
+ 14 dépôts. Chaque finding a été **revérifié contre le code réel** avant
correctif.

**Contexte :** SQLite via better-sqlite3 (WAL), déploiement Pi offline — la
**durabilité** (une DB corrompue ou des blobs perdus = box brickée) prime.
Le binding natif est absent du sandbox : les suites SQLite s'auto-skippent, donc
les correctifs qui exigent une vraie DB sont **vérifiés par relecture** et
exercés en CI ; les autres ont des tests unitaires locaux (stubs/prototype-call).

**Statut :** 10 items corrigés (3 avec tests locaux, le reste vérifié par
relecture + CI). La couche est globalement disciplinée — **aucune injection SQL,
aucun `DROP`/rename destructif, FK cascades actives**. Le reste est listé plus
bas ; un item (upgrade pré-baseline) mérite une **décision**.

---

## ✅ Corrigés

### Cœur DB & sauvegardes

- **M1 (MAJEUR) — restauration non atomique + validation par en-tête seul**
  `Database.restoreFromBackup`. `fs.copyFileSync` écrasait la DB live après
  fermeture ; un échec en cours de copie (disque plein) laissait une DB
  tronquée sans rollback → box brickée. La validation ne lisait que 15 octets
  d'en-tête (un fichier partiel passe). Corrigé : validation par **ouverture
  read-only + `PRAGMA integrity_check`**, puis swap atomique (stage → renommage
  live en `.prerestore` → renommage du stage en place → rollback sur échec).
  Vérifié par relecture (SQLite requis).
- **M2 (MAJEUR) — sauvegardes écrites non atomiquement** `Database.backup`.
  `db.backup()` écrivait droit sur `gmboop-<ts>.db` ; un échec laissait un
  fichier **partiel** qui passait la validation de restore et, classé « le plus
  récent », faisait évincer les bonnes sauvegardes par la rétention. Corrigé :
  écriture en `.tmp` + renommage sur succès, nettoyage du tmp sur échec. Tests :
  `tests/database-backup-atomic.test.js`.
- **MED1 (MOYEN) — GC de blobs orphelins sans plancher** `BackupScheduler._gcOrphanBlobs`.
  Un `listBlobsForManifest()` vide (glitch transitoire) rendait **tout** blob
  orphelin → suppression de tous les MIDI stockés. Corrigé : on saute le GC
  quand l'ensemble référencé est vide. Tests : `tests/backup-scheduler-gc-floor.test.js`.

### Gestionnaires de tables

- **M1-tables (MAJEUR) — `lastInsertRowid` faux après `ON CONFLICT DO UPDATE`**
  `StringInstrumentDatabase.createStringInstrument` + `saveTablature`. Sur le
  chemin d'édition (la ligne existe → UPDATE), SQLite ne met pas à jour
  `last_insert_rowid()`, donc l'id renvoyé au client était celui d'une autre
  table → fetch/patch/delete sur la mauvaise ligne. Corrigé : re-lecture par la
  clé de conflit (`SELECT id … WHERE …`) pour renvoyer le bon id sur les deux
  chemins. Vérifié par relecture (SQLite requis).
- **Md1 (MOYEN) — coercition booléenne asymétrique** `InstrumentSettingsDB`.
  Le chemin INSERT coercait les booléens en 0/1, pas le chemin UPDATE
  (`buildDynamicUpdate`) → better-sqlite3 rejette un booléen JS brut. Corrigé :
  `transforms` coercitifs sur `omni_mode`/`voices_share_notes`/`lighting_enabled`/
  `pitch_bend_enabled` (updateInstrumentSettings) et `enabled`/`midi_clock_enabled`
  (updateById). Vérifié par relecture.
- **Md2 (MOYEN) — routing `created_at` remis à jour à chaque upsert**
  `RoutingPersistenceDB.insertRouting`. `created_at = excluded.created_at`
  bumpait la date de « création » à chaque re-routage. Corrigé : retiré du
  `DO UPDATE SET` (préserve la création). *(Le décalage d'unité ms-vs-secondes du
  schéma reste latent — tous les écrivains passent `Date.now()`, donc la colonne
  est cohérente en ms ; aucun consommateur ne la convertit — documenté.)*

### Dépôts & runner

- **C4-M1 (MOYEN) — reset silencieux de la config hotspot**
  `HotspotConfigRepository.update`. Le merge se faisait sur `get()`, qui avale
  toute erreur de lecture et renvoie les DEFAULTS → un patch d'un champ
  réinitialisait SSID/PSK/bande/canal et **persistait** ce reset (Pi sorti de
  son propre AP). Corrigé : lecture directe ; échec de parse → **throw** ; les
  DEFAULTS ne servent que si la ligne est réellement absente (1ʳᵉ écriture).
  Tests : `tests/hotspot-config-repository.test.js`.
- **C4-M2 (MINEUR) — garde `if (!result) return` manquante**
  `LoopsDB.updateLoop`, `LoopArrangementsDB.updateArrangement`. Sûr aujourd'hui
  (injection de `updated_at`), mais footgun. Corrigé : garde de parité ajoutée.
- **N2 (MINEUR) — `ROLLBACK` non gardé dans le runner** `DatabaseLifecycle`.
  Un `ROLLBACK` sur une transaction déjà auto-abortée masquait l'erreur de
  migration réelle. Corrigé : `try/catch` autour des deux `ROLLBACK`.
- **N1 (doc) — « une transaction pour tout le batch » inexact** → `CLAUDE.md`
  corrigé : chaque migration est dans **sa propre** transaction (par fichier).

---

## 🟠 Ouverts — décision / à planifier / documentés

- **UPGRADE-M1 (MAJEUR, conditionnel) — DB pré-baseline : les migrations
  002–034 seraient sautées.** `001_baseline` enregistre la version **1** puis la
  chaîne post-baseline **réutilise les entiers 2..34**. Si une DB pré-0.7.0
  utilisait la même table `schema_version` (versions 1..40 de l'ancienne
  chaîne), le runner (`hasMigration(db, version)`) skippe 002..034 → tables
  manquantes → crashes runtime (pas de corruption). **Fresh install et upgrades
  intra-0.7.0 non affectés.** Aucun code de réconciliation legacy n'existe.
  → **DÉCISION** : (a) offsetter la nouvelle chaîne au-dessus du max legacy
  (ex. démarrer à 100), (b) réconciliation « legacy détecté → rejouer les
  additifs », ou (c) documenter que les DB pré-baseline ne sont pas
  upgradables en place. À arbitrer selon l'existence de déploiements pré-baseline.
- **D1 (MOYEN) — tolérance `duplicate column name` trop large** `DatabaseLifecycle`.
  Masquerait une vraie erreur d'auteur (colonne dupliquée par mégarde).
  → restreindre aux versions de collision connues (6, 19) ou vérifier a
  posteriori que les colonnes visées existent. Documenté.
- **Minors cœur DB** : écritures playlist non transactionnelles
  (`addPlaylistItem`, `clearPlaylistItems`) ; `updatePlaylistSettings` sans
  null-check ; `close()` ne remet pas `this.db=null` ; `prepare()` par appel
  (idiomatique) ; `start()` non idempotent ; sidecars `.manifest.json`
  orphelins non purgés ; restore non coordonné avec le scheduler.
- **Minors tables** : `MidiDatabase` `device_id IN (…)` échappé à la main
  (sûr, mais convertir en placeholders) ; `searchFiles`/`instrumentTypes` LIKE
  non wildcard-échappés (sémantique incohérente, pas d'injection) ; `prepare()`
  en boucle (`reconcileDeviceId`, `saveSysExIdentityForDevice`) ; lectures
  « premier match » non déterministes (legacy) ; `BankEffectsDB.upsert` clobbe
  les 5 colonnes (sûr via le caller) ; `DeviceSettingsDB.getDeviceSettings`
  renvoie `undefined` au lieu de `null` (cosmétique).
- **Lectures pleine table sans LIMIT** (petites cardinalités sur Pi) — noté.

---

## Vérifié CORRECT (pour éviter la re-revue)

- **Sauvegarde = vraie sauvegarde en ligne** : `db.backup()` (API Online Backup
  SQLite), pas un `fs.copyFile` d'une DB WAL live → snapshot cohérent même sous
  écritures concurrentes. Rétention (tri mtime desc + slice) correcte.
- **`foreign_keys = ON`** posé à chaque `connect()` (hors transaction) → cascades
  actives ; **WAL** activé ; `busy_timeout` par défaut (5 s) de better-sqlite3.
- **`buildDynamicUpdate` sans injection** : identifiants uniquement depuis des
  allow-lists codées en dur, valeurs bindées `?`. Aucune injection SQL dans
  toute la couche ; les clauses `IN (…)` utilisent des placeholders générés.
- **Migrations sûres** : ordre **numérique** (010 après 009) ; **aucun** DROP/
  rename ; tout `ADD COLUMN NOT NULL` porte un `DEFAULT` satisfaisant son
  `CHECK` ; `011` (json_remove) et `010`/`030`/`020` vérifiés non destructifs ;
  tracking de version atomique (schéma + `schema_version` dans la même
  transaction) ; parité runner startup / `npm run migrate`.
- **Intégrité** : upserts `ON CONFLICT DO UPDATE` (pas `INSERT OR REPLACE`
  destructif) ; JSON lus derrière des `CHECK(json_valid)` ou `_safeJsonParse` ;
  coercition 0/1 correcte (`!!`, `!== undefined`) ; écritures composites
  transactionnelles ; comptes de binds = colonnes.
