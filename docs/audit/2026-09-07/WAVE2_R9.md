# Vague 2 — R9 · compte rendu

**Portée :** `scripts/update.sh`, `src/system/UpdateStatus.js` (nouveau),
`src/api/commands/SystemCommands.js`, la route `/api/update-status` de
`src/api/apiRoutes.js`.
**Findings visés :** F-120 (P1), F-121 (P2), F-122 (P2) · **et en prime** F-115 (P3,
même endpoint) et le P3 « `resolve('./backups')` relatif au cwd » de §4.5.

---

## 1. La question qui commande tout : l'ordre des opérations

Avant d'écrire le moindre `git reset`, il fallait répondre à ceci : *les
migrations tournent-elles avant ou après le remplacement du code, et cet ordre
permet-il un rollback ?*

L'ordre réel, inchangé par ce lot :

```
pull (code)  →  npm install (deps)  →  npm run build (front)  →  npm run migrate (schéma)  →  restart
```

**Cet ordre est le seul possible, et il est sûr — à une condition.**

- Les migrations **ne peuvent pas** précéder le pull : les fichiers
  `migrations/NNN_*.sql` de la nouvelle version n'existent pas encore.
- Elles **ne peuvent pas** suivre le redémarrage : le nouveau code démarrerait
  sur l'ancien schéma. (Elles tournent d'ailleurs *aussi* au démarrage du
  serveur ; les faire tourner explicitement avant le restart est ce qui rend
  l'échec visible et rattrapable pendant que l'ancien processus tourne encore.)
- Donc les migrations sont **le dernier point de non-retour**, et comme les
  migrations SQL de ce projet n'ont **pas de down-step**, la seule façon de
  revenir en arrière est une **copie du fichier de base prise juste avant**.
  C'est la condition. Elle n'existait pas ; elle existe maintenant.

Ce que ce lot **ne** referme **pas** : la fenêtre « ancien code / nouveau
schéma » entre le pull et le restart (§4.1 de l'audit). Elle est atténuée par
le caractère additif des migrations, et le rollback la traite comme un tout
(code + base reviennent ensemble). La supprimer vraiment demanderait d'arrêter
le serveur pendant la mise à jour — c'est-à-dire de renoncer au choix de design
v2.0 du script (« le serveur reste debout »), ce qui n'est pas du ressort de R9.

---

## 2. Le mécanisme retenu

### 2.1 Point de restauration, armé avant que quoi que ce soit ne bouge

`_create_restore_point()` est appelé **avant** le stash et **avant** le pull ;
s'il échoue, la mise à jour n'a pas lieu (`abort_and_restart`). Il écrit dans
`logs/update-restore/` — répertoire **gitignoré**, donc hors d'atteinte de
`git reset --hard` et de `git clean`, ce qui était la condition pour qu'un
point de restauration survive à sa propre utilisation :

| Fichier | Contenu |
|---|---|
| `head` | `git rev-parse HEAD` avant le pull |
| `branch` | branche courante (vide = HEAD détaché) |
| `config.json` | **copie de la configuration de l'opérateur** |
| `created-at` | horodatage lisible |
| `in-progress` | marqueur, effacé **uniquement** en fin de succès ou de rollback |
| `db-snapshot` | chemin de la copie de base prise avant les migrations |

La copie de base (`backups/pre-update-<horodatage>.db`) est prise **juste avant
`npm run migrate`**, par `sqlite3 .backup` si le binaire est là (copie en ligne
cohérente pendant que le serveur écrit), sinon par `cp` du fichier **et de ses
sidecars `-wal`/`-shm`**. Elle atterrit dans `backups/`, donc `system_restore`
la voit depuis l'UI — ce qui n'était vrai qu'« à condition que le cwd soit la
racine du projet » : `SystemCommands` résout désormais `backups/` sur
`PROJECT_ROOT` (P3 de §4.5 fermé).

### 2.2 Étape critique vs étape cosmétique

C'était **le vrai défaut** de F-120 : échouer une migration et échouer à
recopier une icône étaient tous deux des `print_warning`, et le script sortait
0 dans les deux cas.

| Étape | Classe | En cas d'échec |
|---|---|---|
| `git pull` | critique | rollback (le checkout n'est pas atomique) |
| `npm install` (+ repli `--ignore-scripts`) | **critique** | rollback — nouveau code sur anciennes dépendances = crash au boot = boucle systemd |
| `npm run build` (bundle Vite) | **cosmétique** | avertissement, la mise à jour continue |
| `npm run migrate` | **critique** | rollback code **+ base** |
| redémarrage (2 tentatives) | **critique** | rollback |
| port en écoute après redémarrage | **critique** | rollback |

Trois précisions qui comptent :

1. **La sortie d'erreur des migrations n'est plus jetée.** `2>/dev/null` →
   `2>&1` : la cause de l'échec est dans le journal (correctif #4 de l'audit).
2. **Le bundle est cosmétique mais n'est plus destructeur.** `dist/` est déplacé
   en `dist.prev` avant le build ; en cas d'échec l'ancien bundle est remis.
   Avant, un build interrompu laissait un `dist/index.html` présent mais
   tronqué — et c'est le seul test que fait `HttpServer` pour servir `dist/`.
3. **« Port fermé » ≠ « port invérifiable ».** `PORT_PROBE_AVAILABLE` distingue
   les deux : sur un hôte sans `lsof`/`ss`/`netstat`, on avertit au lieu de
   défaire une mise à jour parfaitement saine.

### 2.3 Le rollback lui-même

`_rollback "<raison>"` (statut `rolling_back` pendant l'opération) :

1. `git checkout -f <branche>` puis `git reset --hard <PREV_HEAD>` ;
2. `_restore_config` — le `reset --hard` vient précisément d'écraser
   `config.json` ;
3. `_restore_database` **si et seulement si** les migrations ont démarré : la
   base migrée est **déplacée** (`*.failed-update-<ts>`), jamais supprimée, puis
   la copie d'avant est remise ;
4. `npm install` pour recoller `node_modules` au `package.json` restauré ;
5. `_restart_server` — le serveur repart sur l'ancienne version ;
6. statut final `failed: <raison> (rolled back to <sha7>)`, sortie 1.

`UPDATE_ROLLBACK=0` conserve l'ancien comportement (« avertir et continuer »),
explicitement, pour un dépannage en SSH — et même là, `config.json` est restauré.

### 2.4 Coupure de courant

Un `SIGINT`/`SIGTERM` déclenche le rollback (`trap _on_signal`). Une **coupure
de courant** ne se piège pas : c'est le marqueur `in-progress` qui la rattrape.
Au démarrage suivant, `_check_stale_restore_point` :

- annonce qu'une mise à jour n'a jamais fini, et depuis quand ;
- **remet `config.json`** — toujours sûr, et c'est ce que l'utilisateur perd ;
- **ne défait pas le code tout seul** (la machine tourne peut-être très bien sur
  la nouvelle révision depuis des semaines) mais imprime la commande exacte :
  `git -C <projet> reset --hard <sha>` ;
- `_clear_orphan_index_lock` supprime un `.git/index.lock` de plus de 10 minutes
  — le résidu exact d'une coupure pendant `git pull`, celui qui casse **toutes**
  les commandes git ensuite, `system_check_update` compris (correctif #5).

### 2.5 F-121 — `config.json` survit, quoi qu'il arrive

`config.json` est un fichier **suivi** que l'opérateur édite sur place. Il est
copié dans le point de restauration **avant** l'auto-stash, puis remis
**immédiatement après le pull** et **après chaque `git reset`**. L'auto-stash
est conservé (c'est un filet légitime pour les autres fichiers modifiés) mais il
ne peut plus manger la configuration, et le message de fin le dit.

> Alternative écartée : `.gitattributes merge=ours` (exige un pilote de fusion
> configuré côté machine, et ne protège pas de `reset --hard`) ou
> « désuivre `config.json` + livrer `config.example.json` » — plus propre sur le
> fond, mais c'est un changement de contrat d'installation qui déborde de R9 et
> touche des fichiers tenus par d'autres lots. Le mécanisme retenu protège la
> configuration **sans** changer ce contrat.

### 2.6 F-122 / F-115 — `/api/update-status`

La logique est sortie de `apiRoutes.js` (fichier partagé) vers
**`src/system/UpdateStatus.js`**, testable sans serveur. La route est réduite à
quatre lignes. Trois changements :

| Défaut | Avant | Après |
|---|---|---|
| Lecture non bornée | `readFileSync(update.log)` entier, à chaque requête, puis `.slice(-30)` | `openSync`+`readSync` sur les **64 Ko de queue** au plus, 30 lignes (même technique que `system_logs`) |
| Permanence | le statut et le journal de la **dernière** mise à jour servis indéfiniment | fenêtre : étape en cours **fraîche** (< 30 min) ou état terminal **récent** (< 10 min) ; en dehors, `{"status":null,"logTail":null}` |
| Divulgation | 30 lignes de journal servies en permanence | journal servi **uniquement pendant** une mise à jour en cours ; au repos, seul l'état — le journal reste lisible via `system_logs`, authentifié |

L'endpoint **reste public** : c'est un choix de conception (le tableau de bord
sonde pendant que le serveur redémarre sous lui), et `r1-http-auth-bypass`
continue de le vérifier. Public veut désormais dire **borné et temporaire**.

Le vocabulaire d'états (`script_started`, `started`, `pulling`, `installing`,
`migrating`, `restarting`, `verifying`, `rolling_back`, `done`, `failed`) est
maintenant **partagé** : `update.sh` l'écrit, `UpdateStatus.js` le parse, et
`SystemCommands` s'en sert pour sa détection de drapeau périmé et son filet de
sécurité — lequel, sur `failed`, cesse de surveiller et **relâche le verrou**
`_updateInProgress` au lieu de provoquer un `process.exit(0)` par-dessus le
redémarrage que le rollback vient de faire. Les deux nouveaux états sont ignorés
sans dommage par la SPA (`UPDATE_STEPS[step]` indéfini ⇒ l'étiquette ne bouge
pas) ; aucun fichier front n'a été touché.

---

## 3. Ce qui est prouvé, et comment

**Aucun test n'exécute la vraie mise à jour sur cette machine.**
`tests/audit/r9-update-sandbox.js` fabrique un **dépôt git jetable** sous
`os.tmpdir()` avec un faux `origin` qu'on peut réellement `pull`, y copie le
script **verbatim**, et remplace par des doublures sur `PATH` tout ce qu'il
appelle : `npm`, `node`, `lsof`, `systemctl`, `curl`, `sleep`. Les échecs sont
injectés par variables d'environnement (`FAIL_INSTALL`, `FAIL_MIGRATE`,
`FAIL_BUILD`, `FAKE_PORT_LISTENING`, `FAKE_NODE_MODE`). Le script expose en
plus un **mode bibliothèque** (`GMBOOP_UPDATE_LIB_ONLY=1`) qui définit ses
fonctions et rend la main avant le flux principal — c'est ce qui permet de
tester chaque brique isolément.

**60 tests, tous verts :**

```
tests/audit/r9-update-rollback.test.js        23 tests  (6 scénarios de bout en bout)
tests/audit/r9-update-restore-point.test.js   22 tests  (briques + coupure de courant + criticité)
tests/audit/r9-update-status-endpoint.test.js 15 tests  (F-122 / F-115)
```

| Scénario | Preuve |
|---|---|
| Mise à jour nominale | sortie 0, HEAD = révision amont, statut `done`, snapshot de base présent, marqueur `in-progress` effacé |
| **`npm install` échoue** | sortie ≠ 0, HEAD **revenu**, `failed: npm install failed (rolled back to …)`, les migrations n'ont **jamais** tourné |
| **Migration échoue** | HEAD revenu **et** base revenue à `SCHEMA_V1`, copie cassée conservée en `*.failed-update-*`, `SQLITE_ERROR` **visible** dans le journal |
| **Build front échoue** | sortie **0** (cosmétique), migrations faites, **pas** de `dist/index.html` tronqué |
| **Port muet après redémarrage** | rollback complet, serveur relancé sur l'ancienne version |
| `UPDATE_ROLLBACK=0` | ancien comportement, mais statut explicite `(rollback disabled)` |
| **F-121** dans les 6 scénarios | `config.json` de l'opérateur (port 8081) intact alors que l'amont livrait 9999 **et** que l'auto-stash était passé par là |
| **Coupure de courant** | point de restauration périmé détecté, `config.json` remis, commande de récupération imprimée, code **non** défait |
| **`.git/index.lock` orphelin** | vieux verrou supprimé (la mise à jour repart) ; verrou récent conservé (un git peut tourner) |
| **F-115** | `update.log` de 5 Mo ⇒ `logTail` ≤ 64 Ko et ≤ 30 lignes, début du fichier jamais lu |
| **F-122** | `done` vieux de plus de 10 min ⇒ `{status:null}` ; `installing` figé depuis 30 min ⇒ `{status:null}` ; journal jamais servi au repos |

Les assertions de criticité sont doublées d'un garde-fou sur le **texte** du
script (`_critical_failure` sur install/migrate/restart/port, absence de
`2>/dev/null` sur `npm run migrate`, build resté cosmétique, point de
restauration créé avant le stash et le pull) : une régression future se voit
sans rejouer les six scénarios.

---

## 4. Ce qui reste — pour la checklist matérielle L15

Non testable sans un vrai Pi, à vérifier à la main :

1. **Rollback sous PM2 et sous systemd.** Le bac à sable tombe toujours sur le
   repli « démarrage direct de `node` » (pas de PM2, pas d'unité systemd dans le
   conteneur). Les branches `pm2 restart` / `sudo -n systemctl restart` du
   rollback sont **relues, pas exécutées**. À vérifier : mise à jour cassée
   volontairement (`npm install` en échec) sur un Pi sous PM2, puis sous systemd.
2. **`sqlite3 .backup` en ligne.** Le conteneur n'a pas le binaire `sqlite3` :
   c'est le repli `cp` (fichier + `-wal` + `-shm`) qui est prouvé. Sur un Pi avec
   `sqlite3` installé, vérifier que la copie est cohérente pendant que le serveur
   écrit.
3. **Perte d'écritures pendant `_restore_database`.** L'ancien processus tient
   encore l'inode de la base migrée quand on la déplace : les quelques écritures
   faites entre la copie et le redémarrage sont perdues. C'est assumé et
   documenté dans le script ; à observer une fois en conditions réelles.
4. **Vraie coupure de courant** (prise arrachée pendant `git pull`, pendant
   `npm install`, pendant les migrations). Le marqueur `in-progress` et le
   nettoyage d'`index.lock` sont simulés ; le comportement d'un `ext4` sur carte
   SD après coupure ne l'est pas.
5. **F-127 / sudoers.** `sudo -n systemctl restart gmboop` échoue toujours sur
   une installation standard (aucune règle sudoers installée) : le rollback
   retombe alors sur « tuer par port + `node` nu », donc **hors systemd**. R9 ne
   corrige pas ce point — il appartient à F-127 — mais il le rend visible dans le
   journal.
6. **Durée réelle sur Pi 3.** Le `npm install` du rollback rallonge un échec de
   plusieurs minutes ; la fenêtre active de `/api/update-status` (30 min) a été
   dimensionnée large pour cela, à confirmer sur matériel lent.

---

## 5. Fichiers touchés

| Fichier | Nature |
|---|---|
| `scripts/update.sh` | point de restauration, criticité, rollback, reprise après coupure (+ ~330 lignes) |
| `src/system/UpdateStatus.js` | **nouveau** — lecture bornée et fenêtrée du statut/journal de mise à jour |
| `src/api/apiRoutes.js` | route `/api/update-status` réduite à un appel à `readUpdateStatus` (diff minimal) |
| `src/api/commands/SystemCommands.js` | vocabulaire d'états partagé, filet de sécurité qui relâche le verrou sur `failed`, `backups/` ancré sur `PROJECT_ROOT` |
| `tests/audit/r9-update-sandbox.js` | harnais (bac à sable git jetable + doublures) |
| `tests/audit/r9-update-rollback.test.js` | 23 tests |
| `tests/audit/r9-update-restore-point.test.js` | 22 tests |
| `tests/audit/r9-update-status-endpoint.test.js` | 15 tests |

Aucun fichier hors périmètre n'a été modifié ; aucune commande git n'a été
exécutée sur le dépôt de travail ; `scripts/update.sh` n'a **jamais** été lancé
sur cette machine.
