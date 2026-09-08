# Vague 1 — R4 & R5 · compte rendu

**Portée :** `src/persistence/**`, `src/repositories/**`, `src/files/**`, le chemin
`apply_assignments`. **Findings visés :** F-130, F-78 (R5) · F-76, F-77, F-81 (R4).
**Fermé en prime :** F-85.

---

## R5 — `busy_timeout` explicite (F-130 P1, F-78 P2)

### Le problème, tel qu'il était

`busy_timeout` n'était posé **nulle part** : ni dans `Database.connect()`
(`Database.js:98`), ni dans `DatabaseLifecycle.openDatabase()`. La valeur en
vigueur était donc le défaut implicite de `better-sqlite3` — 5 000 ms. Et comme
le pilote est **synchrone**, cette attente n'est pas « une requête lente » :
c'est le **processus entier** qui ne tourne plus, WebSocket, HTTP et
ordonnanceur MIDI compris. L07 avait mesuré 5 015 ms de trou de boucle
d'événements ; L12 avait mesuré un `/api/health` concurrent à 10 095 ms (deux
écritures contendues à la suite : 5 s + 5 s).

### Ce qui a été fait

1. **Un pragma explicite, en un seul endroit.** `applyConnectionPragmas()`
   (`src/persistence/DatabaseLifecycle.js`) pose `journal_mode`, `foreign_keys`
   **et** `busy_timeout` ; les deux sites d'ouverture l'appellent. Le contrat
   n'est plus hérité du pilote.
2. **Valeur retenue : 250 ms**, réglable par `config.database.busyTimeoutMs`
   (ajouté à `config.json`, seul fichier partagé touché ; défaut 250 quand la
   clé est absente). Justification : le seul contendant possible est un **autre
   processus** (`npm run migrate`, un `sqlite3` en ligne de commande, un second
   `npm start`, un outil de sauvegarde) — la connexion écrivante du serveur est
   unique. 250 ms suffisent à absorber un commit externe normal ; au-delà, on
   n'achète plus de robustesse, on achète du gel. Un tick d'ordonnanceur MIDI
   est de l'ordre de 1 à 5 ms : 250 ms est un accroc, 5 000 ms est une panne de
   spectacle.
3. **Le réessai asynchrone**, parce qu'un timeout court, seul, transformerait le
   gel en perte d'écriture. `runWithBusyRetry()`
   (`src/persistence/busyRetry.js`, exposé en `database.runWriteWithRetry()`)
   rattrape `SQLITE_BUSY` et **réessaie à travers un `await`** : la boucle
   d'événements — donc l'ordonnanceur — tourne entre deux tentatives. La
   tolérance totale à un verrou externe redevient `n × 250 ms + backoff`
   pendant que **le gel maximal d'une tentative reste 250 ms**. Branché sur les
   quatre écritures composites de `FileManager` (`saveFile`, `bakeAndSave`,
   `replaceFileBytes`, `createDerivedFile`) — le chemin d'`apply_assignments`.
4. **Une erreur nommée.** Tentatives épuisées ⇒ `DatabaseBusyError`
   (`ERR_DATABASE_BUSY`, 503), qui remonte verbatim au client au lieu du
   `Internal server error` masqué qu'observait L12.

### Mesure avant / après

Même banc (`tests/audit/r5-busy-timeout.test.js`, R5-3) : verrou externe
`BEGIN EXCLUSIVE` tenu 6,5 s, une écriture contendue, sonde de boucle
d'événements à 5 ms.

| | gel max de la boucle d'événements | écriture bloquée | issue |
|---|---|---|---|
| **Avant** (défaut implicite du pilote) | **5 031 ms** | 5 030 ms | `SQLITE_BUSY` |
| **Après** (`busy_timeout = 250`) | **257 ms** | 256 ms | `SQLITE_BUSY` |

**Facteur ≈ 20.** Avec `runWithBusyRetry` (R5-4), un verrou externe de 900 ms est
désormais **absorbé sans échec** — l'écriture passe — et le plus grand trou de
boucle reste **257 ms**.

### Ce qui reste vrai, et qu'il ne faut pas surestimer

Le gel n'est **pas supprimé** : `better-sqlite3` est synchrone, et le supprimer
demanderait de sortir SQLite du thread principal (worker + IPC) — une
réarchitecture, pas un correctif de vague 1. Ce qui est acquis : **une
contention externe coûte désormais ~250 ms au lieu de 5 à 10 s**, et une
contention passagère ne perd plus l'écriture.

---

## R4 — sérialiser les écritures concurrentes (F-76, F-77, F-81)

### Mécanisme retenu : verrou par fichier **+** contrôle de version optimiste

Le roadmap proposait « mutex **ou** compare-and-swap ». Ni l'un ni l'autre ne
suffit seul, et la raison est instructive :

- **Le mutex seul ne corrige rien.** Node est mono-thread et tout le préfixe
  d'`applyAssignments` (lecture du blob → transposition → écriture) était
  **synchrone**. Deux requêtes ne s'entrelaçaient donc jamais vraiment : la
  seconde démarrait *après* l'écriture de la première et lisait sa sortie comme
  entrée. Sérialiser ce qui est déjà sérialisé redonne exactement 70 + 5 + 7 = 82.
- **Le CAS seul ne détecte rien**, pour la même raison : l'instantané de la
  seconde requête, pris à son entrée, est déjà celui d'après l'écriture de la
  première. Aucune dérive n'apparaît.

C'est leur **combinaison** qui ferme le trou, et l'ordre est le cœur du
correctif :

1. l'instantané de version est pris **synchronement, avant tout `await`** ;
2. `await lock.acquire(originalFileId)` — `acquire()` **cède toujours la main**,
   ce qui rend les deux requêtes réellement concurrentes : la seconde prend son
   instantané pendant que la première attend encore son tour ;
3. le verrou tenu, l'instantané est **revérifié**. S'il a bougé, l'appel est
   refusé (`ConflictError`, `ERR_CONFLICT`, 409) et **n'écrit rien**.

Le jeton de version couvre tout ce qu'un apply peut écraser : `content_hash` de
l'original, identité **et** `content_hash` du fichier adapté enfant, et une
empreinte stable du jeu de routages `auto_assigned=1 AND enabled=1` du fichier
cible (colonnes volatiles `id` / `created_at` exclues ; les routages manuels et
désactivés sont hors empreinte puisqu'un apply n'y touche pas).

**Propriété obtenue :** parmi N applies concurrents sur un même fichier,
**exactement un écrit** ; tous les autres reçoivent un 409 explicite portant
`expected` / `actual`. Aucune écriture n'est perdue en silence.

**Non-régression volontaire :** un conflit ne peut se déclencher qu'entre
applies **simultanément en vol**. Un ré-apply séquentiel prend son instantané
après la réponse précédente, ne voit aucune dérive, et se comporte exactement
comme avant (test W-3b et R4-8).

Fichiers : `src/files/FileWriteLock.js` (nouveau),
`src/midi/playback/commands/PlaybackAssignmentCommands.js`,
`src/core/errors/index.js` (`ConflictError`, `DatabaseBusyError`).

### Avant / après, sur les scénarios exacts de l'audit

| Scénario | Avant | Après |
|---|---|---|
| `overwriteOriginal`, +5 et +7 sur une note 70 | fichier à **82**, **deux** `success: true` | fichier à **75**, un `success`, un **409** |
| `overwriteOriginal`, +5 et −5 | retour à **70** — les deux adaptations perdues | fichier à **75**, un `success`, un **409** |
| sans overwrite, +12 et −12 | un fichier adapté au contenu de B, A reçoit `success` + le même `adaptedFileId` | un seul écrit, contenu **et** routage cohérents, l'autre reçoit un 409 |
| 8 applies simultanés | (non testé) | 1 gagnant, 7 × 409, `integrity_check = ok` |

### F-81 — `instrument_delete` atomique

Les quatre suppressions (`instruments_latency`, `string_instruments`,
`instrument_voices`, `midi_instrument_routings`) étaient dans quatre `try/catch`
séparés, hors transaction, avec un `{ success: true }` renvoyé quoi qu'il
arrive — deux des quatre `catch` avalaient même l'erreur sans la journaliser.

Elles vivent désormais dans **une seule transaction**,
`InstrumentRepository.deleteInstrumentCascade()` (ADR-002 §Conventions : les
écritures composites appartiennent au Repository). Une erreur réelle provoque un
rollback complet et **remonte au client** ; seule une table optionnelle
*réellement absente* reste tolérée — et elle est désormais **rapportée**
(`skippedTables`) au lieu d'être avalée. `RoutingPersistenceDB.deleteRoutingsByDevice`
et `StringInstrumentDatabase.deleteByDevice` renvoient le nombre de lignes et
**relèvent** l'erreur au lieu de la journaliser en silence. Le JSDoc du handler,
qui promettait des cascades vers `instrument_light_state`,
`instrument_light_config` et `lighting_rules` **inexistantes**, dit maintenant la
vérité et renvoie explicitement à F-79, toujours ouvert.

### F-85 fermé en prime

`apply_assignments` prenant le verrou *avant* de lire, un apply concurrent d'une
suppression du même fichier voit la disparition et le dit (`NotFoundError`) au
lieu de « réussir » à vide. Le blob adapté n'est plus écrit du tout : **plus
aucun orphelin** en attente du prochain GC de sauvegarde (test W-4).

---

## Tests

**Nouveaux** — `tests/audit/r5-busy-timeout.test.js` (7),
`tests/audit/r4-apply-assignments-concurrency.test.js` (9),
`tests/audit/r4-instrument-delete-atomic.test.js` (7),
`tests/audit/r4-file-write-lock.test.js` (8). Toutes les bases de test vivent
sous `GMBOOP_TEST_TMP` (mécanisme déjà utilisé par les suites L07) ; `./data/`
n'est jamais touché.

**Suites d'audit mises à jour** — elles encodaient le défaut, elles encodent
maintenant le bon comportement :

- `l07-sqlite-concurrency.test.js` : X-1 (`busy_timeout` 5000 → 250), X-3 (verrou
  court ramené sous le nouveau seuil), X-4 (échec propre en ~250 ms au lieu de
  ~5 s), X-5 (gel ramené de ~5 000 ms à ~250 ms).
- `l07-app-concurrency.test.js` : W-1, W-2, W-3 et W-4 réécrits ; W-1b et W-3b
  ajoutés (variante +5/−5, et non-régression du ré-apply séquentiel).
- `tests/instrument-delete-virtual-device-eviction.test.js` : le double de test
  suit le passage aux quatre suppressions vers le cascade transactionnel.

---

## Ce qui reste ouvert

- **Le gel n'est pas supprimé, il est borné** (~250 ms). Le supprimer suppose de
  sortir SQLite du thread principal — hors vague 1.
- **`GMBOOP_DATABASE_BUSY_TIMEOUT_MS` n'existe pas.** Le réglage est lisible
  depuis `config.json` uniquement : câbler la variable d'environnement demande
  une ligne dans `src/core/Config.js`, hors de mon périmètre.
- **Les écrivains hors `apply_assignments` ne prennent pas le verrou** (éditeur
  MIDI, `file_routing_bulk_sync`, suppression de fichier). Une écriture
  concurrente **avant** la prise du verrou est bien détectée par le CAS ; une
  écriture qui tomberait **pendant** la section critique ne l'est pas. Étendre
  `FileWriteLock` à ces chemins est le prolongement naturel.
- **F-79** (orphelins et résurrection : `instrument_voices`,
  `instrument_light_state`, `instrument_light_config`, `lighting_rules` sans clé
  étrangère, et `deleteInstrumentLightByDevice()` jamais appelée) est **hors R4**
  et reste entier. Le JSDoc ne prétend plus le contraire.
- **W-5 / W-6** (mise à jour perdue sur les réglages d'instrument sans jeton de
  version ; absence de `UNIQUE(playlist_id, position)`) restent en l'état :
  hors du périmètre de R4.
- **Aucune migration SQL n'a été créée** — le remède n'en demandait aucune.
