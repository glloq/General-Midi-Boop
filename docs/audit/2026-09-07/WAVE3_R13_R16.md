# WAVE3_R13_R16 — Capacité morte des mains (F-139 P1) · Fermeture de T3 live ≠ baké (F-60 P2)

**Base :** vague 3 du `REMEDIATION_ROADMAP.md` · **Date :** 2026-09-08
**Autorité amont :** `13_FEATURE_COMPLETENESS.md` §F-139 · `05_PLAYBACK.md` §5
(table des 9 axes, F-59/F-60) · `06_ROUTING_ADAPTATION.md` §11 (forme du
correctif L06) · `docs/V0.9_ROADMAP.md` §T3

---

## Résumé

Les deux items ont été traités **ensemble**, comme le lot l'exigeait : câbler
les ancres de main uniquement côté playback aurait ajouté un dixième axe de
divergence live ≠ baké au moment même où R16 en ferme trois.

| # | Ce qui était cassé | Ce qui est livré |
|---|---|---|
| **R13** | `hand_anchors`, `disabled_notes` et `note_assignments` : validés, persistés (migration 009), **redessinés à l'écran**, jamais lus par le moteur | Les trois listes sont lues par **le lecteur live ET le baker**, via un module de normalisation unique. Une note désactivée n'est plus jouée ; une ancre épinglée est la valeur du CC de position émis. |
| **R16** | 3 divergences ouvertes sur 9 axes (`suppressOutOfRange`, filtrage `supported_ccs`, éviction polyphonique) | **Les 3 sont fermées**, chacune prouvée par une comparaison **octet à octet** live ↔ baké. F-59 (repli de plage en double exemplaire) est fermé au passage. Une **4ᵉ divergence non répertoriée** a été trouvée et fermée. |

**Cause racine commune, trouvée en instruisant R13 :** `MidiPlayer.buildEventList()`
ne posait **aucun `tick`** sur les événements du timeline. Toutes les données
d'override sont sérialisées en ticks (indépendance au tempo) ; la clé
`` `${tick}:${note}` `` du `HandAssigner` ne pouvait donc **jamais** correspondre.
Le seul champ que le moteur *croyait* consommer (`note_assignments`) était donc
mort lui aussi — silencieusement, sans aucune trace.

**État à l'issue :** **210 suites / 2 904 tests backend** · **88 fichiers /
1 604 tests frontend** · `eslint src/ public/js/ tests/` **0 erreur** ·
`tsc --noEmit` **clean** · `prettier --check` vert sur les fichiers touchés.

---

## 1. R13 — Les ancres câblées, et par quel chemin

### 1.1 Le chemin, de bout en bout

```
midi_instrument_routings.hand_position_overrides   (migration 009, inchangée)
        │
        ├── LIVE ─── MidiPlayer._loadRoutingsFromDB → routing.handOverrides
        │              │
        │              ├── _applyDisabledNotes()          ← NOUVEAU
        │              │     marque `_handDisabled` sur le note-on ET son note-off
        │              │     → PlaybackScheduler.scheduleEvent() saute l'événement
        │              │
        │              └── _injectHandPositionCCEvents()
        │                    ├── indexHandOverrides(routing.handOverrides)
        │                    ├── notes filtrées des `_handDisabled`
        │                    ├── HandAssigner(..., {noteAssignments: handPins})
        │                    └── planner.plan(notes, {anchors})     ← NOUVEAU
        │
        └── BAKÉ ─── MidiBaker.bake()
                       ├── _indexRoutingOverrides(routings)   ← NOUVEAU (même module)
                       ├── _collectDisabledEvents(track, …)   ← NOUVEAU
                       │     retire le note-on ET son note-off DES OCTETS
                       └── _planSemitonesMode / _planFretsMode
                             └── planner.plan(notes, {anchors})
```

Le point d'entrée unique est **`src/midi/adaptation/HandOverrides.js`** (nouveau) :
`indexHandOverrides()` applique **exactement** les règles de validité de
`HandPositionFeasibility._indexOverrides` côté client — mêmes clés
(`` `${handId}:${tick}` ``, `` `${tick}:${note}` ``), mêmes prédicats, même
séparation « une entrée porte soit `{string,fret}` soit `{handId}`, jamais les
deux ». Ce que l'opérateur voit simulé à l'écran est donc ce que le moteur
planifie. Le module accepte la chaîne JSON brute comme l'objet déjà parsé, parce
que le lecteur parse au chargement du routage et que le baker lit la ligne DB.

### 1.2 Ce que fait chaque liste, maintenant

| Liste | Effet moteur | Où |
|---|---|---|
| **`disabled_notes`** | La note **n'est pas jouée** : ni Note On, ni Note Off, ni créneau de polyphonie. Elle est aussi **retirée de l'entrée du planificateur**, donc elle ne fait plus déplacer la main pour rien. | `MidiPlayer._applyDisabledNotes` + `PlaybackScheduler.scheduleEvent` (live) · `MidiBaker._collectDisabledEvents` (baké) |
| **`hand_anchors`** | La fenêtre de main est **forcée** sur l'ancre au tick épinglé ; le CC de position émis porte cette valeur. L'ancre n'est **pas** re-recalée sur l'accord (ce serait déplacer le choix de l'opérateur) : elle est seulement bornée à la plage physiquement adressable. | `HandPositionPlanner.plan(notes, {anchors})` · `LongitudinalPlanner.plan(notes, {anchors})` |
| **`note_assignments`** (pins de main) | Fonctionnel pour la première fois : le `tick` manquant est désormais posé sur les événements. Le baker les honore aussi (il ne les lisait pas du tout). | `MidiPlayer` + `MidiBaker._planSemitonesMode` |

**Deux avertissements non bloquants** ont été ajoutés, pour que l'opérateur soit
prévenu plutôt que silencieusement corrigé :

- `anchor_out_of_reach` — l'ancre demandée sort de la plage adressable ; elle est
  bornée, et la valeur demandée + la valeur appliquée sont dans le message ;
- `anchor_unplayable` — l'ancre épinglée ne couvre pas l'accord de ce tick
  (`groupLow < anchor` ou `groupHigh > anchor + span`). **Elle est appliquée
  quand même** : l'opérateur commande, le moteur signale.

Ils partent par le même canal que les autres avertissements de faisabilité
(`playback_hand_position_warnings`), donc l'UI les reçoit sans changement.

### 1.3 Sémantique d'unisson — dite explicitement

Une entrée `disabled_notes` est une clé `(tick, note)`. Deux voix en **unisson
au même tick** ne sont pas distinguables — ni par l'éditeur, ni par le moteur —
donc désactiver « la » note les retire **toutes les deux**, avec leurs deux Note
Off appariés (aucune note orpheline). Les deux chaînes font strictement la même
chose ; c'est vérifié par un test dédié. Ce n'est pas un bug, c'est la
granularité du format de l'éditeur, et elle est désormais écrite quelque part.

### 1.4 Non-régression

- Aucun override ⇒ `plannerAnchors()` renvoie `null`, les planificateurs prennent
  le chemin d'origine et la sortie est **strictement identique** à l'avant-R13
  (test dédié, comparaison d'octets).
- `_applyDisabledNotes()` est **idempotent** et **réversible** : il efface ses
  propres marques avant de les reposer, donc un ré-routage — ou le retrait de
  l'override — rend la note.
- Le champ `tick` ajouté sur les événements est additif ; les 210 suites passent.

---

## 2. R16 — La table des 9 axes, état final

Protocole inchangé (`05_PLAYBACK.md` §5.1) : chemin **LIVE** = fichier original
+ paramètres runtime ; chemin **BAKÉ** = fichier adapté hors-ligne rejoué **sans**
paramètre runtime ; comparaison `serializeBytes()` via le harnais de rejeu
déterministe L05 (`tests/audit/l05-replay-harness.test.js`, horloge injectée) —
réutilisé, pas réécrit.

| # | Axe | État à l'audit | **État final** | Preuve |
|---|---|---|---|---|
| 1 | Transposition de canal | ✅ identique | ✅ **inchangé** | `l05-live-vs-baked` §cas 1 |
| 1b | Transposition au bord (>127) | ✅ identique | ✅ **inchangé** | idem |
| 2 | Remap de notes (batterie) | ✅ identique | ✅ **inchangé** | §cas 2 |
| 2b | Ordre transposition → remap | ✅ identique | ✅ **inchangé** | §cas 2 |
| 3 | Repli de plage (T3.2) | ✅ identique | ✅ **inchangé** | §T3.2 |
| 3b | *Code* du repli — **F-59** | ⚠️ **deux copies** du même algorithme | ✅ **FERMÉ** — `MidiTransposer.compressNoteToRange` délègue à `NoteEnforcement.foldIntoRange` ; une seule implémentation pour les trois chaînes | `r16-live-vs-baked-t3` §axe 3b |
| 4 | **`suppressOutOfRange`** | ❌ **NON** — offline supprime, live replie (`[40,60,96]` → live `[52,60,72]`, baké `[60]`) | ✅ **FERMÉ** — le runtime a la même politique, et `applyAssignments` la lui donne | `r16` §axe 4 (5 tests, parité octet à octet) |
| 5 | Snap `selected_notes` / gamme (T3.3) | ⚠️ converge au rejeu, aperçu/export faux | ⚠️ **DIVERGENCE ASSUMÉE** (§3.1) | `r16` §assumées |
| 5b | `selected_note` hors plage | ✅ T3.3 fermé | ✅ **inchangé** | §T3.3 |
| 6 | **Filtrage CC (`supported_ccs`)** | ❌ **NON** — runtime seulement ; `ccMapping` renumérote sans filtrer, le CC 74 reste dans les octets | ✅ **FERMÉ** — prédicat unique `NoteEnforcement.isCCAllowed`, appliqué aussi hors-ligne | `r16` §axe 6 (6 tests) |
| 7 | Polyphonie — choix de la victime (T3.1) | ✅ identique (helper partagé) | ✅ **inchangé** | §T3.1 |
| 7b | **Polyphonie — effet audible** | ❌ **NON** — la voix médiane sonne puis est coupée en live, n'est jamais émise en baké | ✅ **FERMÉ** — l'offline reproduit l'éviction du runtime au lieu d'effacer rétroactivement un Note On | `r16` §axe 7b (4 tests) + `l05-live-vs-baked` inversé |
| 8 | `min_note_interval` (T3.4) | ⚠️ runtime seulement, converge | ⚠️ **RUNTIME-SEULEMENT, ASSUMÉ** (§3.2 — **raison révisée par la vague 4 / R23**) | `r16` §assumées · `r23` §F-61a |
| 8b | T3.4 mono vs poly | ✅ fermé | ✅ **inchangé** | §T3.4 |
| 9 | `min_note_duration` | ⚠️ runtime seulement | ⚠️ **RUNTIME-SEULEMENT, ASSUMÉ** (§3.2 — **raison révisée par la vague 4 / R23**) | `r16` §assumées · `r23` §min_note_duration |
| **10** | **Ordre des CC de main sur la grille de ticks** — *non répertorié par l'audit* | ❌ trouvé par ce lot | ✅ **FERMÉ** (§2.4) | `r16` §hors-table |

**Bilan : 3 divergences ouvertes → 0. Une divergence nouvelle trouvée → fermée.
Trois axes restent runtime-seulement, assumés et documentés au §3.**
*(Axes 8 et 9 : la raison écrite au §3.2 a été révisée par la vague 4 / R23 —
ces gardes ne dépendent plus du temps réel. Voir l'encadré du §3.2 et
`WAVE4_R21_R23.md` §6.)*

### 2.1 Axe 4 — `suppressOutOfRange`

**Le défaut n'était pas un désaccord de calcul, c'était un choix qui n'atteignait
qu'une seule chaîne.** L'opérateur coche « supprimer les notes hors plage »
(`oorHandling: 'suppress'`, `RoutingSummaryAssignmentBuilder.js:114`) ; ce choix
partait dans `MidiTransposer` et **nulle part ailleurs**. Le runtime, lui, n'avait
aucune politique : il repliait, toujours. Donc :

- avec fichier adapté ⇒ les notes hors plage disparaissent ;
- **sans** fichier adapté (`createAdaptedFile: false`) ⇒ le choix de l'opérateur
  était **purement et simplement ignoré**, sans un mot.

**Décision : le comportement offline est le bon** — c'est ce que l'opérateur a
demandé, explicitement, dans l'interface. Le repli reste le **défaut** (aucun
changement pour qui ne coche rien).

Correctif :

- `NoteEnforcement.isOutOfRange(note, constraints)` — prédicat partagé, avec la
  même garde que l'offline (les **deux** bornes doivent être déclarées) ;
- `MidiPlayer.channelOutOfRangePolicy` : `Map<channel, 'suppress'>`, le troisième
  paramètre d'adaptation runtime **à côté de** `channelTransposition` et
  `channelNoteRemapping`, avec le même contrat (panic du canal au changement, pour
  ne pas laisser une note admise sous l'ancienne politique) ;
- `PlaybackScheduler._dispatchToDevice` : évalué **après** transposition+remap et
  **avant** le repli — l'ordre exact des étapes de `transposeChannels` ;
- `PlaybackAssignmentCommands` : `setChannelOutOfRangePolicy(ch, …)` posé au même
  endroit que `setChannelTransposition`, et avec la même règle
  `adaptationBaked ? null : …` (pas de double application).

Le Note Off suit la note : il traverse la même transformation, est donc lui aussi
hors plage, et est supprimé. Aucune note orpheline (test dédié).

> **Limite honnête :** la table `midi_instrument_routings` n'a **pas** de colonne
> pour cette politique. Elle survit donc à l'`apply`, mais **pas à un
> rechargement**. La moitié « écriture » est un diff hors périmètre, donné au §4.1 ;
> la moitié « lecture » est déjà en place (`MidiPlayer._loadRoutingsFromDB` lit
> `routing.out_of_range_policy`), donc la fonction sera complète le jour où la
> colonne arrive, sans nouvelle chasse au point d'insertion.

### 2.2 Axe 6 — filtrage `supported_ccs`

**Décision : le comportement live est le bon** — un CC non déclaré peut
dérégler le firmware d'un instrument mécanique ; il n'a rien à faire dans les
octets d'un fichier adapté, qui est censé décrire *ce que l'instrument va
recevoir*.

La règle existait **en deux copies** (`PlaybackScheduler._isCCSupported`,
`MidiRouter._enforceLiveLimits`) et **pas du tout** hors-ligne. Elle est
maintenant écrite **une fois**, dans `NoteEnforcement.isCCAllowed`, et les trois
chaînes l'appellent — c'est exactement la forme du correctif L06/F-64, appliquée
au troisième chemin. Un test le vérifie sur la *source* des trois consommateurs,
pour que la prochaine copie soit rouge.

Comportement conservé à l'identique : CC 120–127 (mode canal / sécurité), Bank
Select 0/32 et les **CC de position de main de l'instrument** passent toujours ;
une liste non déclarée laisse tout passer ; **CC 20/21** restent gouvernés par
leur porte propre (instrument à cordes avec `cc_enabled`) et non par
`supported_ccs`. Côté hors-ligne, la porte cordes est transmise via
`transposition.stringCCAllowed`.

Le filtre s'applique **après** la renumérotation `ccMapping`, sur le numéro final
— comme le runtime, qui ne voit que le numéro final. Vérifié : `CC1 → 7` survit,
`CC7 → 74` part.

`applyAssignments` alimente ces trois champs depuis **le même
`CapabilityResolver`** que le scheduler et le routeur. Pour un assignement
*split*, le filtre n'est appliqué hors-ligne que si **tous** les segments
déclarent la même chose (sinon on ne bake rien : le runtime filtrera par
destination, ce qui est strictement plus sûr).

### 2.3 Axe 7b — éviction polyphonique : la voix médiane

C'est la divergence la plus intéressante, parce que **l'alignement n'était
possible que dans un seul sens**.

L'offline traite les événements dans l'ordre ; quand la polyphonie déborde, la
victime est la **médiane des voix actives**, c'est-à-dire le plus souvent une
note **déjà commencée** — et il **efface rétroactivement son Note On**, ce qu'un
fichier permet et qu'un flux temps réel interdit. Le runtime, lui, a déjà frappé
la note : T3.1 lui a fait adopter la même politique de victime (`keep-outer`),
mais il ne peut que la **relâcher** (Note Off avant la note entrante).

Aligner le live sur le baké supposerait de déplacer l'enforcement de polyphonie
dans une passe de planification sur tout le timeline : cela dupliquerait la
chaîne de transformation de hauteur hors du scheduler, casserait la protection
contre ce qui est injecté après le chargement (seek, transposition live,
changement de routage) et ne s'appliquerait de toute façon pas au route-through
live, qui n'a pas de futur à lire.

**Décision : le comportement live est le bon, et c'est l'offline qui s'aligne.**
Le runtime est l'autorité : *tout* fichier baké est rejoué à travers lui, donc
une sortie hors-ligne qu'il ne peut pas reproduire est, par construction, une
promesse fausse. `MidiTransposer` reproduit désormais l'éviction :

- victime = la note **entrante** ⇒ elle n'est jamais frappée (son Note On est
  supprimé), exactement comme la porte du runtime la bloque ;
- victime = une voix **déjà en train de sonner** ⇒ son Note On est **conservé** et
  un Note Off est inséré **au tick de la note évinçante**, juste avant elle ; son
  Note Off naturel est retiré.

L'ordre d'octets est identique parce que `EVENT_ORDER_PRIORITY` place `noteOff`
(8) avant `noteOn` (9) à tick égal — soit exactement l'ordre du runtime, qui
envoie le Note Off de la victime puis le Note On admis dans le même callback.
La stratégie `'shorten'` (`reducePolyphonyGentle`) est intacte et reste distincte.

> **Ce que cela change à l'oreille :** rien en live. En baké, une voix évincée est
> désormais **frappée puis relâchée** au lieu d'être absente — c'est-à-dire ce que
> l'instrument fait déjà en lecture directe depuis T3.1. Le point de contrôle
> matériel **HW-8** de `15_HARDWARE_QA_CHECKLIST.md` reste donc entièrement
> pertinent ; simplement, s'il conclut que la frappe parasite est inacceptable sur
> un actionneur mécanique, le correctif est désormais **au même endroit pour les
> deux chaînes**, et les deux bougeront ensemble.

### 2.4 Axe 10 (nouveau) — les CC de main tombaient du mauvais côté de la note

Trouvé en construisant les tests de parité de R13, **non répertorié par l'audit**.

Les deux planificateurs émettent un CC de décalage « au plus tôt » :
`note_on précédent + 0,1 ms`. Cet epsilon est **très en dessous d'un tick**
(≈ 1,04 ms à 480 ppq / 120 BPM). `MidiBaker._secondsToTicks` arrondissait donc le
CC sur le tick de la note précédente, où `_mergeEventsIntoTrack` trie les
contrôleurs **avant** les notes : le fichier baké déplaçait la main **une note
trop tôt**, alors que le live la déplace juste après. Divergence réelle, audible
sur un actionneur, et complètement invisible jusqu'ici.

Correctif : les planificateurs marquent chaque CC d'un `placement` (`'pre'` pour
le placement initial `t_first − ε`, `'post'` pour un décalage `t_prev + ε`), et
`MidiBaker._ccEventTick` arrondit **en s'éloignant de la note de référence**
(`Math.ceil` pour `'post'`). L'intention traverse la quantification, là où le
flottant ne pouvait pas.

---

## 3. Divergences assumées — et pourquoi

Trois axes restent **runtime-seulement**. Ce ne sont pas des divergences de
sortie : le fichier baké, rejoué, traverse le même enforcement, donc **les deux
chemins convergent octet à octet** (deux tests le prouvent). Ce qui diffère,
c'est ce que le **fichier** contient.

### 3.1 Axe 5 — snap `selected_notes` / gamme : l'aperçu ne montre pas ce qui sera joué

`transposeChannels` ne connaît ni `selectedNotes` ni `octaveMode` ; seul le
runtime snappe. **Assumée** parce que fermer cet axe reviendrait à graver dans le
fichier adapté une hauteur qui n'appartient qu'à *un* instrument : le fichier
cesserait d'être réassignable à un autre instrument sans perte irréversible.
Le repli de plage (axe 3) est différent — il est déjà baké — parce qu'il est
appliqué via une étape explicite et optionnelle (`noteCompression`) que
l'opérateur choisit.

*Conséquence à connaître :* l'**aperçu** et l'**export** d'un fichier adapté ne
reflètent pas le snap. C'est une limite d'affichage, pas de son.

### 3.2 Axes 8 et 9 — `min_note_interval` / `min_note_duration`

Gardes **temporels**, appliqués au moment de l'émission et dépendants du temps
réel (position de lecture, `playbackRate`, compensation de latence par
destination). Les graver hors-ligne supposerait de figer un tempo de lecture et
une destination — et rendrait le fichier faux dès que l'un des deux change.
**Assumées** : ce sont des propriétés de *l'émission*, pas du *contenu*.

> Rappel : `F-55` / `F-61` (vague 4, R23) montrent que ces gardes suppriment
> aujourd'hui **1 note sur 8** dans certaines configurations. Tant que R23 n'a pas
> tranché la grandeur de référence (temps musical vs temps mur), les graver dans
> le fichier fixerait une décision qu'on sait discutable.

> ### ⚠️ Mise à jour vague 4 (R23) — la justification ci-dessus est en partie caduque
>
> R23 (`WAVE4_R21_R23.md` §3 et §6) a tranché la grandeur de référence, et le
> paragraphe qui précède **n'est plus exact sur son point central** : ces gardes
> **ne dépendent plus du temps réel**.
>
> - `min_note_interval` est évalué sur `event.time` divisé par `playbackRate`.
>   Ni la gigue, ni la compensation de latence par destination, ni le retard du
>   downbeat (F-55, corrigé) n'entrent plus dans la décision. Mesuré : **12,5 %
>   de notes supprimées → 0 %**, et **0 % sous cinq modèles de gigue**.
> - `min_note_duration` : la **décision** (« faut-il étirer cette note ? ») est
>   musicale et reproductible ; seule la **quantité** d'étirement reste mesurée
>   sur l'instant réel de la frappe, pour que le solénoïde reste engagé la durée
>   promise.
>
> **Ce qui reste vrai**, et qui devient la seule raison de les laisser hors du
> fichier : ils dépendent de `playbackRate` **et de la destination**
> (`min_note_interval` / `min_note_duration` sont des capacités d'instrument).
> Les graver figerait le fichier adapté sur un taux de lecture et un instrument.
> La classification passe donc de « divergence assumée parce que dépendante du
> temps réel » à **« runtime-seulement, assumé parce que dépendant du taux et de
> la destination »** — plus étroit, et vérifiable.
>
> **Ce qui est levé :** l'avertissement « tant que R23 n'a pas tranché… ». La
> convergence live ↔ baké prouvée ici tient toujours, et tient désormais **par
> construction** plutôt que parce que les deux rejeux voyaient la même horloge
> virtuelle.

---

## 4. Ce qui n'a pas été fait, et pourquoi — diffs hors périmètre

Le lot interdisait `src/persistence/**`, `src/api/**`, `public/js/**`,
`src/lighting/**`. Deux correctifs les touchent ; ils sont donnés ici, prêts à
appliquer.

### 4.1 Persister la politique hors-plage (complète l'axe 4 à travers un rechargement)

**a) `migrations/010_routing_out_of_range_policy.sql`** (nouveau) :

```sql
-- Migration 010 — politique hors-plage par routage (R16 axe 4 / audit F-60).
-- Le choix « replier / supprimer » de l'écran d'assignation n'était appliqué
-- que par la chaîne hors-ligne ; le runtime le porte désormais aussi
-- (MidiPlayer.channelOutOfRangePolicy), mais ne peut pas le retrouver après un
-- rechargement sans cette colonne.
ALTER TABLE midi_instrument_routings
    ADD COLUMN out_of_range_policy TEXT
    CHECK(out_of_range_policy IS NULL OR out_of_range_policy IN ('fold', 'suppress'));

INSERT OR REPLACE INTO schema_migrations (version, description)
VALUES (10, 'Add out_of_range_policy to midi_instrument_routings');
```

**b) `src/persistence/tables/RoutingPersistenceDB.js`** — ajouter la colonne aux
deux `INSERT` (split et upsert), au `DO UPDATE SET`, et au `SELECT` de
`getRoutingsByFile` :

```diff
             assignment_reason, note_remapping, enabled, created_at,
-            hand_position_feasibility, hand_position_overrides)
-        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
+            hand_position_feasibility, hand_position_overrides, out_of_range_policy)
+        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(midi_file_id, channel) WHERE split_mode IS NULL
         DO UPDATE SET
           ...
-          hand_position_overrides = excluded.hand_position_overrides
+          hand_position_overrides = excluded.hand_position_overrides,
+          out_of_range_policy = excluded.out_of_range_policy
```

```diff
         routing.hand_position_feasibility ? ... : null,
-        overridesJson
+        overridesJson,
+        routing.out_of_range_policy === 'suppress' ? 'suppress' : null
```

et dans le mapping de lecture (`:255` environ) :

```diff
       hand_position_overrides: row.hand_position_overrides ? ... : null,
+      out_of_range_policy: row.out_of_range_policy || null,
```

**c) `src/midi/playback/commands/PlaybackAssignmentCommands.js`** — une ligne à
ajouter aux trois littéraux `routing` (le fichier **est** dans mon périmètre, mais
la ligne serait morte tant que (a) et (b) ne sont pas là, ce que R13 condamne
précisément ; elle n'a donc **pas** été ajoutée) :

```diff
       note_remapping: runtimeRemapJson(assignment),
+      out_of_range_policy:
+        !adaptationBaked && assignment.suppressOutOfRange ? 'suppress' : null,
       enabled: true,
```

Côté lecture, **rien à faire** : `MidiPlayer._loadRoutingsFromDB` lit déjà
`routing.out_of_range_policy` (résolu à `'fold'` aujourd'hui).

### 4.2 Ce qui reste ouvert autour de F-139

- **`hand_position_overrides` n'est écrit que par `routing_hand_overrides_set`**
  (`src/api/commands/RoutingCommands.js`), qui est bien appelé par les éditeurs.
  Aucun changement nécessaire — vérifié, pas supposé.
- **`wiki/Interface-Hand-Management.md`** promettait « *Pin anchor → Lock the hand
  to the current position* ». **C'est vrai maintenant.** Aucune correction de
  documentation n'est due : c'est le code qui a rattrapé le wiki.
- **`capo_fret`** (F-140) reste une capacité morte côté moteur — hors R13, traité
  par R14.

---

## 5. Tests

### 5.1 Ajoutés

| Fichier | Tests | Ce qu'il verrouille |
|---|---|---|
| `tests/audit/r13-hand-overrides-engine.test.js` | **27** | Normalisation partagée · ancres dans les deux planificateurs (dont hors-plage et injouable) · `tick` posé sur le timeline · `disabled_notes` live, baké **et parité octet à octet** · unisson · `hand_anchors` live/baké/parité · pins `note_assignments` · non-régression + idempotence + réversibilité |
| `tests/audit/r16-live-vs-baked-t3.test.js` | **22** | Axe 4 (6 tests) · axe 6 (6 tests, dont « les trois chaînes appellent le même prédicat ») · axe 7b (4 tests) · axe 3b/F-59 (3 tests) · axe 10 (1 test) · divergences assumées (2 tests) |

Chaque parité est une égalité **octet à octet** de la trace d'émission, pas une
comparaison de compteurs.

### 5.2 Suites d'audit inversées

`tests/audit/l05-live-vs-baked.test.js` encodait le comportement **mesuré**
pendant l'audit. Trois cas documentaient un défaut désormais corrigé ; ils sont
inversés vers le bon comportement, avec la raison en commentaire :

| Test | Avant | Après |
|---|---|---|
| §cas 4 | *« DIVERGENCE : l'offline SUPPRIME, le live REPLIE »* | scindé en deux : **choix appliqué d'un seul côté ⇒ divergence** (la forme historique de F-60, toujours vraie et instructive) **+ même choix des deux côtés ⇒ octets identiques** |
| §cas 6 | *« DIVERGENCE : `supported_ccs` filtre au runtime, l'offline ne le connaît pas »* | renommé *« sans capacités hors-ligne, `ccMapping` renumérote et ne filtre pas »* (toujours vrai) **+ nouveau test de parité avec `supportedCcs`** |
| §T3.1 | *« DIVERGENCE RÉSIDUELLE : l'offline supprime la note, le live la fait sonner puis la coupe »* | **« FERMÉ (R16 axe 7b) : l'offline reproduit l'éviction du runtime — octet à octet »**, avec la séquence complète attendue |

Aucune autre suite `l05-*` / `l06-*` n'a bougé : `l06-live-vs-playback-cc-parity`,
`l06-capability-matrix` et `l06-routing-adaptation-edges` passent telles quelles —
le correctif F-64 est préservé par construction, puisque le routeur délègue
désormais au prédicat partagé qui porte la même règle.

### 5.3 État final mesuré

```
npm test        → 210 suites / 2 904 tests   ✅ (aucune en échec)
npx vitest run  →  88 fichiers / 1 604 tests ✅
npx eslint src/ public/js/ tests/ → 0 erreur (203 warnings, tous préexistants)
npx tsc --noEmit → clean
```

---

## 6. Fichiers touchés

**Nouveaux**

- `src/midi/adaptation/HandOverrides.js` — normalisation unique des overrides.
- `tests/audit/r13-hand-overrides-engine.test.js`, `tests/audit/r16-live-vs-baked-t3.test.js`.

**Modifiés**

| Fichier | Pourquoi |
|---|---|
| `src/midi/playback/MidiPlayer.js` | `tick` sur les événements · `_applyDisabledNotes()` · overrides passés aux planificateurs · `channelOutOfRangePolicy` + son setter + son transport dans l'état du scheduler · lecture de `out_of_range_policy` au chargement des routages |
| `src/midi/playback/PlaybackScheduler.js` | saut des événements `_handDisabled` · politique hors-plage · `_isCCSupported` délègue au prédicat partagé |
| `src/midi/adaptation/HandPositionPlanner.js` | `plan(notes, {anchors})` · `placement` sur les CC · avertissements d'ancre |
| `src/midi/adaptation/LongitudinalPlanner.js` | idem, plus extraction de `_promoteAnchors` / `_emitIfChanged` |
| `src/midi/adaptation/NoteEnforcement.js` | `isCCAllowed`, `isActuatorCC`, `isOutOfRange` — le module d'enforcement unique recommandé par L05+L06 |
| `src/midi/adaptation/MidiTransposer.js` | `compressNoteToRange` délègue (F-59) · filtrage CC hors-ligne · éviction polyphonique alignée sur le runtime |
| `src/midi/routing/MidiRouter.js` | `_enforceLiveLimits` délègue au prédicat partagé |
| `src/midi/playback/commands/PlaybackAssignmentCommands.js` | `destinationCCCapabilities()` · politique hors-plage posée sur le lecteur |
| `src/files/MidiBaker.js` | overrides (ancres + notes désactivées) · retrait d'événements · tick des CC sensible au `placement` |
| `tests/audit/l05-live-vs-baked.test.js` | trois cas inversés (§5.2) |

Aucun fichier hors périmètre n'a été modifié.
