# Audit B2/B3 — Fichiers/bake & Core/lifecycle (2026-08-08)

Audit adversarial (4 relecteurs parallèles) de la couche fichiers (parsing MIDI,
bake, SF2, stockage, upload) et du cœur/lifecycle (composition root, DI, EventBus,
Config, Logger, monitoring, bootstrap). **Les fichiers MIDI et SF2 sont des
uploads non fiables** — robustesse face aux entrées hostiles = priorité. Chaque
finding a été revérifié contre le code réel.

**Statut :** 15 items corrigés (5 avec tests locaux), dont **1 CRITIQUE** (OOM
SF2), 3 MAJEURS (upload SF2 mort, OOM upload MIDI, teardown non isolé). Le reste
(perf, misbehavior, minors) est documenté. Suite : **135 suites / 1476 tests** vertes.

---

## ✅ Corrigés

### Fichiers / bake (B2)

- **C1 (CRITIQUE) — OOM SF2 depuis un chunk RIFF forgé** `SF2Converter.parseSoundFont`.
  La lib soundfont2 itère selon la longueur DÉCLARÉE des chunks sans la borner au
  buffer → un fichier de 1 Ko annonçant un `phdr` de ~4 Go alloue jusqu'à un abort
  V8 fatal (non catchable), et le blob poison (content-addressed) re-crashe la box
  à chaque accès. Corrigé : `validateSf2Structure` valide l'arbre RIFF (toute
  longueur de chunk/sous-chunk doit tenir dans son conteneur) **avant** le parse,
  au parse ET à l'ingest (`sf2Routes`), donc aucun blob poison ne peut être stocké.
  Tests : `tests/sf2-structure-validate.test.js`.
- **M1 (MAJEUR) — upload SF2 mort en déploiement par défaut** `SF2PresetService.getTotalStoredSize`.
  La ligne sentinelle id=0 stocke la mtime (~1,75e12) dans sa colonne `size` ;
  la sommer dépassait le quota 1 Go → tout upload custom rejeté en 413. Corrigé :
  exclusion de id=0 du quota et de la liste GET. Tests : `tests/sf2-quota-sentinel.test.js`.
- **B2a (MAJEUR) — OOM depuis un upload MIDI ≤10 Mo** `FileManager.handleUpload`.
  Seul le cap de 10 Mo bornait l'upload ; un fichier de note-ons en running-status
  décode en millions d'events clonés ~3× (parse + convertMidiToJSON + ChannelAnalyzer)
  → ~1-2 Go, OOM. Corrigé : plafond `MAX_UPLOAD_MIDI_EVENTS=1e6` rejeté AVANT
  l'analyse (413 côté client), blob orphelin nettoyé.
- **Md2 (MOYEN) — file d'upload wedgée** `UploadQueue`. Une tâche qui ne se
  résout jamais bloquait la chaîne mono-worker → tous les uploads suivants en
  `UPLOAD_QUEUE_FULL` à vie. Corrigé : timeout par tâche (`taskTimeoutMs=60s`,
  `Promise.race`) laissant la chaîne avancer. Tests : `tests/upload-queue-timeout.test.js`.
- **Baker — tempo ≤ 0** `MidiBaker._buildTempoMap`. Un `setTempo 0` (parseable)
  → division par zéro → ticks Infinity/NaN → delta-times corrompus dans le fichier
  baké. Corrigé : ignorer `microsecondsPerBeat <= 0` (aligné sur `extractTempoMap`).
- **Baker — CC injecté après `endOfTrack`** `MidiBaker._mergeEventsIntoTrack`.
  Un CC placé après le tick d'end-of-track sortait APRÈS lui et était ignoré par
  les players conformes (adaptation perdue). Corrigé : `endOfTrack` repoussé au
  tick max + forcé strictement dernier. Tests : `tests/midi-baker-merge.test.js`.
- **B2c-M2 (MOYEN) — `reanalyzeAllFiles` bloque la boucle d'events**
  `FileManager`. Lecture+parse+analyse+écriture synchrones par fichier sans yield
  → gel du thread sur une grosse bibliothèque. Corrigé : `setImmediate` tous les 5
  fichiers.

### Core / lifecycle (B3)

- **A1 (MAJEUR) — `stop()` abandonnait le teardown sur la 1re exception**
  `Application.stop`. Un throw dans une étape sautait toutes les suivantes —
  `deviceManager.close()` (silence des instruments) et `database.close()`
  (checkpoint WAL) n'étaient jamais atteints. Corrigé : chaque étape isolée en
  try/catch (best-effort, DB en dernier), plus de re-throw.
- **M1 (MOYEN) — le logging pouvait crasher l'appelant** `Logger`.
  `JSON.stringify` d'un payload circulaire/BigInt throw dans `format`/`formatJson`.
  Corrigé : try/catch → `[unserializable…]` (JSON toujours valide). Tests :
  `tests/logger-safe-stringify.test.js`.
- **M2 (MOYEN) — une rotation ratée tuait le log fichier** `Logger._rotate`.
  Le stream était nullifié avant un unlink/rename qui, s'il throw, sautait la
  réouverture. Corrigé : réouverture dans le catch.
- **M4 (MOYEN) — échec de `start()` au boot sans `stop()`** `server.js`. Une
  rejection catchée n'active pas les handlers signaux → DB non checkpointée,
  instruments sans all-notes-off. Corrigé : `await app.stop()` dans le catch.
- **M5 (MOYEN) — EventLoopMonitor inondait logs/WS** (~100/s sous lag, amplifiant
  le lag). Corrigé : report throttlé (5 s) ; la mesure reste à chaque tick.
- **M6 (MOYEN) — chemins DB/log absolus rejetés** `Config`. Un opérateur pointant
  la DB sur un SSD externe (`/mnt/ssd/...`) était silencieusement ignoré. Corrigé :
  chemins absolus autorisés (garde `..` conservée).
- **m1 / m8 (MINEUR)** — `EventBus.once()` se détache maintenant en `finally`
  (un callback qui throw ne reste plus abonné) ; `Application.start()` a une garde
  anti-double-start (sinon timers backupScheduler/eventLoopMonitor fuités).

---

## 🟠 Ouverts — perf / misbehavior / documentés

- **Baker O(N²)** `_ticksToSeconds`/`_secondsToTicks` scannent la tempo-map par
  note → gel possible sur un fichier à nombreux `setTempo`. → index cumulatif /
  recherche binaire (à planifier).
- **MidiFileValidator advisoire** : son résultat `valid/errors` est ignoré par
  `handleUpload` (seuls `warnings`/`stats` sont lus). Le cap d'events ci-dessus
  couvre l'OOM ; reste à faire respecter `!valid` (rejeter les shapes dangereuses).
- **SF2 Md1** : `SF2InstanceCache` borne le NOMBRE d'entrées (2), pas les octets
  (~2× taille fichier retenue) → deux SF2 de 160 Mo peuvent OOM un Pi 1 Go. →
  budget d'octets / baisser `MAX_SF2_FILE_SIZE` (décision de tuning).
- **B2c-M1** : `saveFileAs` dédup silencieusement (UNIQUE content_hash) et renvoie
  un id/nom existant ; le backend expose déjà `status:'duplicate'` — **le frontend
  doit le traiter** (audit C) au lieu d'annoncer « enregistré sous {nom} ».
- **B3-M3** : `Logger.close()` (flush) n'est jamais appelé en prod → dernières
  lignes perdues à l'exit. À flusher dans le handler de shutdown (pas dans
  `stop()`, à cause de `restart()`), avec `stream.end(cb)`.
- **Minors** : baker JsonMidiConverter (Format 0→1, SMPTE) ; VLQ 32-bit (lib) ;
  BlobStore dédup existence-only (pas de re-hash) ; `getFileMetadata` note
  double-count (fallback) ; `bakeAndSave` TOCTOU ; 3 bases `channelCount` ;
  `getStorageStats`/`broadcastFileList` scoping `/` ; `createFolder` no-op ;
  EventBus emit ré-entrance ; watchdog d'exit ; commentaire `unhandledRejection`
  faux ; `config.json` malformé → revert silencieux ; constants non tous frozen ;
  pas de redaction de secret dans Logger ; `filterFiles` COUNT(*) vs DISTINCT ;
  HTTP `?folder=` sans `validateFolder`.

---

## Vérifié CORRECT (pour éviter la re-revue)
- **Parse MIDI robuste** : `Buffer.slice` borne les over-reads ; `numTracks`
  (UInt16) borné ; pas de boucle infinie (curseur avance) ; texte multi-Mo throw
  (catché) ; tous les `parseMidi` sont wrappés + blob orphelin nettoyé.
- **Intégrité FileManager** : `content_hash UNIQUE` (1 ligne/blob), cascades FK
  actives, chemins blob toujours dérivés du hash, ordre write-new → commit →
  delete-old (un crash laisse au pire un orphelin GC-able, jamais une référence
  pendante), collision refusée. Path safety complète (aucune string user → fs).
- **SF2** : codec bornes/symétrie ; `SF2Converter` caps de sortie ; `BlobStore`
  `_safeResolve` + write atomique (tmp→fsync→rename) ; `UploadQueue` comptabilité
  d'octets équilibrée.
- **Core** : EventBus isolation par listener ; `ServiceContainer` détection de
  cycle ; Config coercion (NaN/boolean) + précédence ; ordre DI cohérent ;
  `database.close()` en dernier ; `unhandledRejection` NE shutdown PAS (correct) ;
  handlers de shutdown idempotents ; EventLoopMonitor `unref`.
