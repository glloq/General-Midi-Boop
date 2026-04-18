# ADR-003 — Versionnement des contrats WebSocket

- **Statut** : Accepté
- **Date** : 2026-04-17
- **Supersedes** : —
- **Références** :
  [`ADR-001`](./ADR-001-refactor-strategy.md),
  [`tests/contracts/fixtures/`](../../tests/contracts/fixtures/)

## Contexte

À l'entrée de la Phase 4, les contrats WS sont gelés : 42 commandes
critiques (playback + routing) ont des snapshots
`tests/contracts/fixtures/**` qui servent de filet de sécurité aux
refactors. Le plan §7 énonce :

> **Règle de versions des contrats WS** :
> - compatibilité backward par défaut ;
> - en cas de rupture nécessaire, introduire une commande/route `v2`
>   de manière **additive** ;
> - dépréciation annoncée dans le changelog avec date cible de retrait.

L'ADR-003 traduit cette règle en convention opérationnelle : comment
nommer, déprécier, supprimer une version d'une commande WS sans casser
les clients existants (UI, intégrations tierces, scripts d'admin).

## Problèmes adressés

1. **Pas de convention** : aucun mécanisme actuel pour cohabitation
   entre une `playback_start` v1 et une `playback_start` v2 si un
   champ devait changer de type ou disparaître.
2. **Pas de canal de dépréciation** : un client legacy ne sait pas
   qu'une commande va disparaître.
3. **Risque de big-bang** : sans versionnement, toute évolution
   non-additive force une release coordonnée backend + frontend.

## Options considérées

### Option A — Versionner via un en-tête `version` dans chaque message

Chaque payload porte `{ command, version: 'v2', data }`. Le serveur
dispatch sur `command + version`.

- **Avantages** : chaque message est auto-décrivant.
- **Inconvénients** :
  - Casse les clients existants qui n'envoient pas le champ.
  - Coût d'écriture : tous les snapshots doivent être enrichis.
  - Le `version` est rarement utilisé (la majorité des commandes
    n'évoluera jamais).

### Option B — Suffixer le nom de commande pour les nouvelles versions (retenue)

`playback_start` reste la v1. Si une rupture est nécessaire,
`playback_start_v2` est introduite. Les deux cohabitent. La v1 est
marquée dépréciée dans le changelog et le snapshot ; sa suppression
suit un cycle annoncé.

- **Avantages** :
  - Zéro changement pour les clients existants.
  - Les snapshots v1 restent verts pendant toute la dépréciation.
  - Découverte facile (`grep '_v2'`).
  - Aligné avec ce que le plan §7 indique déjà comme « commande/route
    `v2` additive ».
- **Inconvénients** :
  - Espace de noms qui croît (acceptable : v2 reste rare).
  - Un alias serveur peut être nécessaire si v2 = v1 + champ optionnel.
    Dans ce cas, **éviter v2** : ajouter le champ optionnel à v1
    suffit (compatibilité backward par défaut).

### Option C — Capability negotiation au handshake WS

Le client annonce ses capabilities ; le serveur sert la version
maximale supportée.

- **Avantages** : protocole plus moderne, compatible avec des clients
  hétérogènes.
- **Inconvénients** :
  - Lourd pour la valeur apportée à ce stade.
  - Hors scope du refactor (changement de protocole).
  - À reconsidérer si la roadmap introduit des intégrations tierces
    nombreuses.

## Décision

**Option B retenue** : versionnement par suffixe `_vN` sur le nom de
commande, additif uniquement.

## Conventions opérationnelles

### 1. Quand introduire une `_v2`

**Seulement** si l'évolution casse au moins l'une de ces propriétés
de la v1 :
- forme du payload de retour (champ supprimé, type changé) ;
- forme du payload d'entrée (champ devenu requis, type changé) ;
- code d'erreur ou message documenté dans un snapshot ;
- comportement métier observable (ex. semantics de `loop`).

Si l'évolution est **additive** (nouveau champ optionnel, nouveau
champ retourné en plus, nouveau code d'erreur jamais observé avant) :
**garder la v1**, mettre à jour son snapshot.

### 2. Cohabitation v1 ↔ v2

- v1 et v2 sont enregistrées **toutes les deux** dans
  `CommandRegistry`.
- v1 reste fonctionnelle pendant **au moins une release majeure**
  après l'introduction de v2.
- v1 émet un log de dépréciation à l'usage :
  `app.logger.warn('[deprecated] playback_start v1 — use playback_start_v2')`.
- v1 et v2 ont chacune leur propre snapshot
  `tests/contracts/fixtures/<domain>/<cmd>_v2.contract.json`.

### 3. Dépréciation et suppression

- Annonce dans le `CHANGELOG.md` avec date cible de retrait
  (≥ 2 releases majeures plus tard).
- Marqueur dans le snapshot v1 : champ `"deprecated": true` +
  `"replacement": "playback_start_v2"` + `"removalTarget": "v6.0.0"`.
- Suppression effective : `git rm` du handler v1 + snapshot v1, entrée
  `BREAKING CHANGE` dans le changelog.

### 4. Cas particulier — extension purement additive

Pas de v2. Mettre à jour le snapshot v1 avec un nouveau cas (et un
champ optionnel marqué tel quel dans `output_shape`). Ajouter un test
de contrat.

## Schémas affectés (ADR-004)

Les schémas déclaratifs de validation (ADR-004) suivent la même
convention : `playback_start` et `playback_start_v2` sont deux clés
distinctes dans la map compilée. Le compilateur ne traite pas le
versionnement — il valide le payload tel quel.

## Impacts

### Ce qu'on gagne

- Une procédure claire pour les évolutions cassantes futures.
- Pas de rupture pour les clients pendant la phase de dépréciation.
- Snapshots restent gardiens de la stabilité de v1.

### Ce qu'on sacrifie

- Légère duplication temporaire (handler v1 + handler v2 cohabitent).
- Espace de noms qui croît dans `CommandRegistry`.
- Nécessite un changelog discipliné.

## Plan de rollback

Si une `_v2` introduite se révèle inadaptée avant sa promotion :
1. Marquer la v2 comme `experimental` dans son snapshot.
2. Supprimer `_v2` au prochain cycle si non adopté.
3. Aucune migration de données : le format sur fil est seulement
   un détail de protocole.

## Critères de réussite

- À chaque évolution non-additive future d'une commande WS :
  * un nouveau handler `_v2` est créé,
  * un nouveau snapshot `..._v2.contract.json` est ajouté,
  * v1 émet un warning de dépréciation,
  * `CHANGELOG.md` indique la date cible de retrait.
- À la première suppression d'une v1 :
  * release majeure marquée `BREAKING CHANGE`,
  * 100 % des clients connus migrés (grep des projets internes).

## Application immédiate

Cet ADR ne déclenche aucune création de `_v2` à ce stade. Il sert
de référence pour toute évolution future du protocole. Aucun handler
existant n'est modifié.
