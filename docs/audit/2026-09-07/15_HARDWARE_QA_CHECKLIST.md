# 15 — Checklist QA matériel (lot L15)

**Date :** 2026-09-07 · **Commit :** `8dc170e` · **Version :** 0.8.1
**Nature du livrable :** procédure opérationnelle — **rédigée, non exécutée**
(aucun matériel dans l'environnement d'audit).
**Sections couvertes :** K, L, M, O, P01–P04, S, AC, AD, B01/B03, F03/F05, G04,
BJ, BL, BM, BT, BX.
**Findings ouverts par ce lot :** F-164 → F-169 (§12).

> **À qui s'adresse ce document.** À vous, devant le Pi et les instruments, un
> après-midi. Ce n'est pas un rapport d'audit : c'est une liste de gestes à
> faire, avec pour chacun un chiffre à relever. Les 15 sections que trois audits
> successifs ont laissées en `HW REQUIRED` se ferment ici — pas toutes le même
> jour, mais **chaque session terminée en ferme définitivement une partie**.

---

## 0. Mode d'emploi

### Conventions

- Chaque vérification porte un **identifiant stable** `HW-<section>-<nn>`.
  Citez-le tel quel dans vos notes et vos rapports d'échec.
- Chaque vérification tient en deux lignes : le **geste**, puis
  **Critère** (le chiffre qui décide) · **Mesure** (avec quoi l'obtenir) ·
  **Si échec** (ce qu'il faut capturer pour qu'on puisse vous aider à distance).
- Le **matériel est déclaré en tête de session**, pas par vérification : on
  s'assoit une fois avec un jeu de matériel et on enchaîne. Quand une
  vérification demande quelque chose en plus, c'est écrit dans sa ligne.
- Chaque session propose une **variante à matériel réduit**. Elle vaut moins
  qu'une session complète mais elle vaut **beaucoup plus que rien** : elle est
  toujours indiquée.

### Origine des seuils

| Marqueur | Signification |
|---|---|
| `[code]` | Seuil lu dans le code ou la config du projet — la source est citée `fichier:ligne`. |
| `[doc]` | Seuil documenté par le projet (`docs/realtime-pi.md`, `V0.9_ROADMAP.md`…). |
| `[proposé]` | **Aucun seuil n'existe dans le projet.** Celui-ci est une proposition à valider à la première exécution, puis à figer (voir F-168). |

### La règle d'or

**Un `PASS` sans valeur relevée est un `NOT TESTED`.** La colonne « valeur
mesurée » du tableau §10 n'est pas décorative : c'est elle qui rend la session
suivante comparable à celle-ci, et c'est elle qui permet à quelqu'un sans
matériel de conclure quelque chose.

### Journal de session

Ouvrez un fichier texte avant de commencer et notez-y, dans l'ordre :
date, modèle de Pi, version d'OS (`cat /etc/os-release`), commit
(`git rev-parse --short HEAD`), matériel branché. Tout rapport d'échec renvoie
à ce fichier.

---

## 1. Trois paliers de matériel

Le classement ci-dessous détermine l'ordre des sessions. **Vous pouvez vous
arrêter à la fin de n'importe quelle session et avoir déjà gagné quelque chose.**

| Palier | Matériel | Coût | Sessions | Sections fermées |
|---|---|---|---|---|
| **0 — le Pi seul** | Un Raspberry Pi, une carte SD, un écran ou un SSH | déjà là | 1, 2 | B01, B03, AD, F03 (partie logicielle), AG |
| **1 — un câble** | + 1 interface USB-MIDI bouclée (≈ 10 €) · 1 fil de liaison GPIO14→GPIO15 (0 €) · 1 smartphone | ≈ 10 € | 3, 4, 5, 6 | K, M, L, G04, D05, F05, S, P01–P04, AL |
| **2 — l'orchestre** | + micro, instruments réels, bandeau LED, tablette | variable | 7 → 12 | O, AC, BL, BJ, BM, BX, BT |

> **Le meilleur rapport valeur/effort du projet, écrit noir sur blanc dans
> `docs/audit/2026-08-22/22_HARDWARE_VALIDATION.md` :** *« USB + UART loopback
> on a Pi 4. That alone unlocks §K, §M, §F03 and §D05 — four sections, one
> afternoon of wiring, no exotic equipment. »* C'est le palier 1, sessions 3 et
> 4. Si vous ne faites qu'une chose, faites celle-là.

---

## 2. Préparation commune (une fois, ~10 min)

```bash
cd /opt/gmboop            # ou votre chemin d'installation
git rev-parse --short HEAD                 # à noter dans le journal
cat /etc/os-release | head -2              # à noter
node -v                                    # doit être >= 20
```

Activez les logs détaillés **pour la durée des sessions**, sinon la moitié des
mesures ci-dessous sont invisibles :

```bash
# .env
GMBOOP_LOG_LEVEL=debug
```

Les logs applicatifs ont un horodatage ISO à la milliseconde
(`src/core/Logger.js:129`) et sont dans `logs/gmboop.log` (rotation intégrée).
Sous systemd : `journalctl -u gmboop -f`.

Les cinq outils que vous utiliserez tout du long — **tous déjà dans le dépôt,
n'en installez pas d'autres** :

| Outil | Où | À quoi il sert ici |
|---|---|---|
| `curl -s localhost:8080/api/health \| jq` | `src/api/apiRoutes.js:58` | état global + par capacité |
| `curl -s localhost:8080/api/capabilities \| jq` | `src/api/apiRoutes.js:73` | détail par transport (public, pas de token) |
| `curl -s localhost:8080/api/metrics` | `src/api/apiRoutes.js:93` | RSS, heap, clients WS (**texte Prometheus, pas JSON** — cf. F-165) |
| `bash scripts/check-rt-setup.sh -v` | — | vérifie que le réglage temps réel est **réellement actif** |
| `npm run bench` / `npm run perf:load` | `tests/performance/` | jitter d'ordonnancement, débit, pente de heap — **avec assertions intégrées** |
| `node scripts/audit/live-probe.mjs http://127.0.0.1:8080` | — | contrat HTTP/WS de bout en bout, imprime `PASS`/`FAIL` par point |

> ⚠️ **`/api/health` ment sur deux points** (findings F-01 et F-02 de l'audit du
> 2026-08-22, toujours ouverts). `usb: ready` est renvoyé **même sans
> bibliothèque MIDI native** (`Application.js:717` : la présence du
> `deviceManager` suffit), et `ble: ready` peut apparaître après un échec
> d'initialisation. **Ne validez jamais §K ou §L sur la foi de `/api/health`.**
> La preuve, c'est une note qui revient (HW-K-02) ou un périphérique qui
> apparaît au scan (HW-L-02).

---

## 3. Session 1 — Pi neuf, installation propre (≈ 45 min, aucun instrument)

**Sections :** B01, B03, AD (partiel), AG · **Palier 0**
**Matériel :** un Raspberry Pi (3B+, 4 ou 5), une carte SD fraîchement flashée
en Raspberry Pi OS Bookworm 64-bit, réseau, un accès SSH ou clavier+écran.
**Variante réduite :** aucune — c'est déjà le minimum absolu.

- [ ] **HW-B01-01 · Installation automatique** — carte SD neuve, `git clone`, puis `./scripts/Install.sh`.
      **Critère :** sortie 0, aucun `[ERREUR]` dans le déroulé · **Mesure :** `echo $?` + durée totale chronométrée · **Si échec :** la sortie complète du script à partir de la première erreur, et l'étape numérotée où elle survient.
- [ ] **HW-B01-02 · Modules natifs réellement compilés** — c'est **la** différence avec l'environnement d'audit, qui n'a jamais pu compiler `midi`.
      **Critère :** les trois commandes ci-dessous réussissent sans exception · **Mesure :** `node -e "import('better-sqlite3').then(()=>console.log('sqlite OK'))"`, idem avec `easymidi` et `serialport` · **Si échec :** le message d'erreur complet + `dpkg -l | grep libasound2-dev`.
- [ ] **HW-B01-03 · Assets d'exécution présents** — les deux fichiers téléchargés par `postinstall` et **non versionnés**.
      **Critère :** `assets/sf2/default.sf2` > 1 Mo **et** `public/lib/WebAudioFontPlayer.js` non vide · **Mesure :** `ls -l` sur les deux, puis `sha256sum` des deux → **notez les deux empreintes dans le journal** (l'installeur ne vérifie aucune somme de contrôle, F-15) · **Si échec :** le miroir qui a échoué, visible dans la sortie de `scripts/install-default-sf2.js`.
- [ ] **HW-B01-04 · Le service démarre et sert la SPA** — `sudo systemctl start gmboop`.
      **Critère :** `curl -s localhost:8080/api/health` renvoie `"status":"ok"` en moins de 30 s · **Mesure :** chronomètre + `journalctl -u gmboop -n 50` · **Si échec :** les 50 dernières lignes du journal et la sortie de `sudo systemctl status gmboop`.
- [ ] **HW-AG-01 · Le « offline-first » tient au premier chargement** — c'est la reproduction du finding **F-14**. Coupez tout réseau (`sudo ip link set eth0 down; sudo ip link set wlan0 down`), videz le cache du navigateur, chargez `http://<ip-du-pi>:8080`.
      **Critère :** l'interface devient utilisable en **< 10 s** sans aucune requête sortante · **Mesure :** onglet Réseau des DevTools, filtre « autre domaine » ; cherchez spécifiquement `surikov.github.io` · **Si échec :** capture de l'onglet Réseau montrant la requête bloquée, et le temps au bout duquel la page se débloque (ou ne se débloque pas). Sans réseau, `public/index.html:6011` peut exécuter un `document.write` bloquant vers un CDN injoignable.
- [ ] **HW-B03-01 · Démarrage au boot** — `sudo reboot`, sans toucher à rien ensuite.
      **Critère :** `/api/health` répond `ok` en **≤ 90 s** après la fin du boot, sans intervention · **Mesure :** depuis une autre machine, `until curl -sf http://<ip>:8080/api/health; do sleep 2; done` lancé juste avant le reboot, chronométré ; complétez avec `systemd-analyze` · **Si échec :** `systemctl is-enabled gmboop` et `journalctl -b -u gmboop`.
- [ ] **HW-B03-02 · Un seul superviseur, un seul processus** — le piège le plus coûteux de cette session (cf. **F-167**).
      **Critère :** `pgrep -fc "node.*server.js"` renvoie exactement **1** après le boot · **Mesure :** la commande ci-dessus + `pm2 list` (doit être vide ou sans `gmboop` si vous utilisez systemd) · **Si échec :** vous avez deux superviseurs ; notez lequel a gagné le port 8080 et désactivez l'autre **avant** la session 2, sinon tous les chiffres de la session 2 seront faux.
- [ ] **HW-B03-03 · Reprise après crash** — `sudo kill -9 $(pgrep -f "node.*server.js")`.
      **Critère :** le service redémarre seul en **≤ 15 s** (`Restart=always`, `RestartSec=10` dans l'unité écrite par `Install.sh`) et la base n'est pas corrompue · **Mesure :** chronomètre + `curl /api/health` + ouverture de l'UI (les fichiers et instruments sont toujours là) · **Si échec :** `journalctl -u gmboop -n 100` autour du redémarrage.
- [ ] **HW-AD-01 · Alimentation** — laissez tourner 10 min à vide, puis relevez.
      **Critère :** `vcgencmd get_throttled` = `throttled=0x0` · **Mesure :** la commande · **Si échec :** notez la valeur exacte. `0x50000` = sous-tension **survenue** ; une alimentation insuffisante fausse toutes les mesures de timing des sessions suivantes — corrigez avant de continuer.
- [ ] **HW-AD-02 · Thermique au repos, boîtier fermé** — 10 min à vide.
      **Critère :** `vcgencmd measure_temp` < **60 °C** [proposé] · **Mesure :** la commande · **Si échec :** notez la température et la description du boîtier/refroidissement.
- [ ] **HW-AD-03 · Carte SD et disque** — état de santé du support, c'est lui qui lâche en premier sur un Pi de scène.
      **Critère :** `df -h /` montre **≥ 20 %** libre **et** `dmesg | grep -iE "mmc|I/O error"` ne renvoie rien · **Mesure :** les deux commandes · **Si échec :** la sortie de `dmesg` filtrée — une erreur I/O sur mmc condamne la carte, remplacez-la avant les sessions longues.
- [ ] **HW-AD-04 · Horloge** — `timedatectl`.
      **Critère :** `System clock synchronized: yes`, ou, si la boîte est hors ligne par conception, notez-le explicitement · **Mesure :** la commande · **Si échec :** une horloge libre fausse les horodatages de log et la logique de recalibration à 7 jours (`LatencyCompensator.js:21`) — à noter, pas bloquant.
- [ ] **HW-AD-05 · Photographie de départ des capacités** — `curl -s localhost:8080/api/capabilities | jq` **collez la sortie complète dans le journal**.
      **Critère :** `database: ready`, `playback: ready`, `network: degraded` (déclaration honnête et attendue, cf. N02) · **Mesure :** la commande · **Si échec :** toute capacité `failed` doit porter un `detail` explicite ; notez-le.

---

## 4. Session 2 — Temps réel et plateforme (≈ 40 min, aucun instrument)

**Sections :** AD, F03 (partie logicielle), BT (première ligne)
**Prérequis :** session 1 terminée, en particulier HW-B03-02.
**Matériel :** le Pi seul. `sudo apt install -y rt-tests` (une seule fois).
**Variante réduite :** sautez HW-AD-07/08 (cyclictest) et gardez `npm run bench`
— vous perdez la mesure noyau mais gardez la mesure applicative.

- [ ] **HW-AD-06 · Appliquer le réglage temps réel** — `sudo bash scripts/pi-rt-tune.sh --dry-run` d'abord (lisez ce qu'il va changer), puis sans `--dry-run`, puis `sudo reboot`. Sur Pi 3 : ajoutez `--no-isolcpus`.
      **Critère :** le script se termine sans erreur et crée un `.bak` par fichier modifié · **Mesure :** sa sortie · **Si échec :** l'étape en erreur ; le rollback est documenté dans `docs/realtime-pi.md` § « Rolling back ».
- [ ] **HW-AD-07 · Le réglage est réellement actif sur le processus mesuré** — c'est **F-167**, et c'est le piège qui invalide silencieusement toute cette session.
      **Critère :** `bash scripts/check-rt-setup.sh -v` sort en **0** ET affiche `[ok] node running under SCHED_FIFO` · **Mesure :** la commande · **Si échec :** un `[warn] node running under SCHED_OTHER` signifie que le réglage systemd n'atteint pas le processus (typiquement : il tourne sous PM2). Appliquez `sudo chrt -f 30 -p $(pgrep -f "node.*server.js")` et **recommencez toutes les mesures suivantes**. Notez `OK=n WARN=n FAIL=n`.
- [ ] **HW-AD-08 · Jitter noyau au repos** — `cyclictest -p 80 -m -d 0 -i 200 -t 1 -n -l 1000000` (≈ 3 min 20).
      **Critère :** Pi 4 après réglage — **Avg < 10 µs, Max < 300 µs** [doc : `docs/realtime-pi.md`, tableau « Targets »] · **Mesure :** relevez Min/Avg/Max · **Si échec :** suspects listés par la doc — Bluetooth actif, économie d'énergie Wi-Fi, tempête d'I/O SD (une sauvegarde tourne à **03:00** par défaut, `BackupScheduler.js`). Notez les trois chiffres et l'heure.
- [ ] **HW-AD-09 · Jitter noyau pendant la lecture** — relancez `cyclictest` pendant qu'un fichier MIDI dense joue en boucle.
      **Critère :** **Max < 2 ms** [doc : idem] · **Mesure :** relevez Max · **Si échec :** notez Max, le fichier joué, le nombre de canaux actifs. Un Max > 1 ms est le signal le plus précoce d'un orchestre qui sonnera « mou » en session 11.
- [ ] **HW-F03-01 · Jitter applicatif** — `npm run bench` sur le Pi. Le script porte ses propres assertions.
      **Critère :** `playback-jitter p99 < 5 ms`, `p999 < 15 ms`, `snapshot lookup p99 < 0.1 ms` [code : `tests/performance/benchmark.js:211,212,358`] · **Mesure :** relevez `p50 / p99 / p999` et la ligne finale `Assertions: n/n passed` · **Si échec :** collez le bloc `bench-playback-jitter` complet et les assertions échouées. **Ces seuils ont été calibrés sur x86 ; le chiffre du Pi est une nouvelle référence — reportez-le au §10 même s'il passe.**
- [ ] **HW-F03-02 · Débit et pente de heap** — `npm run perf:load`.
      **Critère :** `A.throughput ≥ 150 000 ev/s`, `A.eventloop_p99 < 50 ms`, `B.coalesce_ratio ≥ 0.90`, `C.heap_slope < 8 MB/s` [code : `tests/performance/load-soak.js:123,125,173,216`] · **Mesure :** la ligne `n/n budgets met` + les 4 valeurs · **Si échec :** le budget de débit est celui d'un x86 ; sur Pi 3B+ il peut ne pas tenir. Notez la valeur, **ne concluez pas à un bug** : c'est la ligne de base du modèle.
- [ ] **HW-AD-10 · Thermique sous charge** — 10 min de lecture dense, boîtier fermé, relevé toutes les 30 s : `while true; do vcgencmd measure_temp; sleep 30; done`.
      **Critère :** **< 80 °C** (seuil de bridage ARM) et `vcgencmd get_throttled` toujours `0x0` · **Mesure :** la température max atteinte + la valeur finale de `get_throttled` · **Si échec :** notez la courbe (5 relevés suffisent) et le boîtier. Au-delà de 80 °C le CPU se bride et le jitter explose — tout le reste de la QA devient non représentatif.
- [ ] **HW-AD-11 · Mémoire sur une heure** — laissez le serveur au repos une heure avec l'UI ouverte.
      **Critère :** croissance de `gmboop_memory_rss_bytes` **< 50 Mo/h** [proposé] · **Mesure :** `curl -s localhost:8080/api/metrics | grep rss` au départ et à l'arrivée · **Si échec :** notez les deux valeurs. Attention : `docs/realtime-pi.md` vous dit d'inspecter `outputQueue.droppedByClient` via `| jq` — **cela ne fonctionne pas** (F-165), l'endpoint est du texte Prometheus et n'expose pas ce champ.

---

## 5. Session 3 — Boucle USB MIDI (≈ 45 min, un seul câble)

**Sections :** K, D05, G04, F05, O (aller-retour) · **Palier 1**
**Matériel :** 1 interface USB-MIDI bon marché avec DIN OUT relié à son propre
DIN IN par un câble MIDI (la « boucle »). C'est tout.
**Variante réduite :** un simple clavier maître USB-MIDI (sans boucle) permet
HW-K-01, K-04, K-05, G04-01/02 et S-* ; il ne permet **pas** K-02, D05-01/02
ni F05-01, qui exigent de voir revenir ce qu'on envoie.
**Point d'observation :** `aseqdump -l` pour trouver le port, puis
`aseqdump -p <client:port>` en parallèle de l'application (ALSA autorise
plusieurs abonnés en lecture). L'UI diffuse aussi chaque message entrant en
`midi_event` sur le WebSocket (`DeviceManager.js:1424`).

- [ ] **HW-K-01 · Détection à chaud** — branchez l'interface, serveur déjà démarré, chronomètre en main.
      **Critère :** apparaît dans la liste des périphériques en **≤ 10 s** (sondage hot-plug = 5 000 ms, `DeviceDiscovery.js:38`, plus le scan) · **Mesure :** l'UI + `journalctl -u gmboop -f` · **Si échec :** délai observé, `aconnect -l`, les 30 lignes de log autour.
- [ ] **HW-K-02 · Le chemin USB fonctionne vraiment** — la preuve que `/api/health` ne donne pas. Envoyez un Do central depuis le clavier virtuel vers l'interface.
      **Critère :** la même note revient (note, vélocité, canal identiques) en `midi_event` · **Mesure :** `aseqdump -p <port>` ou le moniteur de l'UI · **Si échec :** notez ce qui revient (rien / autre note / canal décalé) et la sortie de `aseqdump`.
- [ ] **HW-K-03 · Latence aller-retour USB** — mesure de référence du transport, sans audio.
      **Critère :** aller-retour médian **< 10 ms** [proposé — un HAT commercial annonce 1,28 ms en boucle, `docs/GPIO_MIDI_WIRING.md`] · **Mesure :** la commande `latency_measure` (5 itérations, note 60 vél. 64 canal 0, `LatencyCompensator.js:14-18`). **Attention : cette commande n'a aucune surface UI (F-166)** — voir l'encadré ci-dessous · **Si échec :** relevez `latency`, `min`, `max` et le nombre d'itérations abouties.

> **Comment lancer une commande sans UI.** Le paquet `ws` est déjà une
> dépendance du projet ; depuis la racine du dépôt :
> ```bash
> node -e '
> import("ws").then(({WebSocket})=>{const t=process.env.GMBOOP_API_TOKEN||"";
> const w=new WebSocket("ws://127.0.0.1:8080"+(t?`/?token=${t}`:""));
> w.on("open",()=>w.send(JSON.stringify({id:"1",command:process.argv[1],data:JSON.parse(process.argv[2]||"{}")})));
> w.on("message",m=>{console.log(m.toString());process.exit(0)});})' \
>   latency_measure '{"deviceId":"<id>","iterations":5}'
> ```
> Le même appel sert pour `latency_list`, `latency_recommendations`,
> `playback_set_disconnect_policy`, `midi_panic`, `serial_status`… Récupérez
> `<id>` via `device_list`.

- [ ] **HW-K-04 · Deux périphériques de même nom** — branchez **deux** interfaces identiques (le cas que l'audit signale comme non couvert).
      **Critère :** deux entrées distinctes, deux `id` différents, chacune adressable séparément · **Mesure :** `device_list` + envoyez une note à chacune et regardez laquelle boucle · **Si échec :** collez le `device_list` complet ; une déduplication trop agressive fusionnerait les deux.
- [ ] **HW-K-05 · Débranchement à chaud, hors lecture** — débranchez.
      **Critère :** événement `device_disconnected` **≤ 10 s**, aucun crash, `/api/capabilities` toujours servi · **Mesure :** UI + log · **Si échec :** délai observé et éventuelle trace d'exception.
- [ ] **HW-K-06 · Rebranchement : les réglages suivent** — donnez un nom personnalisé à l'instrument, débranchez, rebranchez.
      **Critère :** l'instrument revient **avec son nom et ses réglages** (appariement par `usb_serial_number`) · **Mesure :** la carte instrument dans l'UI · **Si échec :** notez si un doublon apparaît, et la valeur de `usb_serial_number` dans `device_list`.
- [ ] **HW-G04-01 · Débranchement pendant la lecture, politique `skip`** (défaut) — lancez un fichier, débranchez à mi-parcours.
      **Critère :** la lecture **continue**, événement `playback_device_disconnected` avec `policy:"skip"`, log `Device unreachable during playback: <id>` (`PlaybackScheduler.js:851`), **aucune note bloquée sur les autres sorties** · **Mesure :** UI + log · **Si échec :** notez si la lecture s'arrête, si une note reste tenue, et l'événement reçu.
- [ ] **HW-G04-02 · Politique `pause`** — `playback_set_disconnect_policy {"policy":"pause"}`, relancez, débranchez.
      **Critère :** la lecture se met en pause et l'événement porte `policy:"pause"` · **Mesure :** idem · **Si échec :** notez le comportement réel.
- [ ] **HW-G04-03 · Politique `mute`** — `{"policy":"mute"}`, même manipulation.
      **Critère :** l'événement porte `mutedChannels` avec **exactement** les canaux routés vers l'appareil disparu, et eux seuls ; les autres continuent de sonner · **Mesure :** le payload de l'événement · **Si échec :** collez le payload et le routage effectif (`playback_get_channels`).
- [ ] **HW-D05-01 · Panic** — tenez un accord de 6 notes, déclenchez `midi_panic`.
      **Critère :** silence total en **< 200 ms** [proposé] et, sur la boucle, un CC 120 (All Sound Off) **+** CC 123 (All Notes Off) sur **les 16 canaux** · **Mesure :** `aseqdump` (comptez les messages) + chronomètre · **Si échec :** notez quels canaux manquent.
- [ ] **HW-D05-02 · Panic sous saturation WebSocket — reproduction de F-07** — jouez un glissando rapide au clavier virtuel (> 60 événements/s ; chaque note = **une** trame WS, `KeyboardEvents.js:497,524`), puis, sans relâcher la cadence, déclenchez le panic.
      **Critère attendu : ÉCHEC.** Le limiteur WS plafonne à **60 msg/s par connexion** (`WebSocketServer.js:47`) et **n'exempte pas le panic** au niveau WS, contrairement à la couche périphérique · **Mesure :** le panic répond-il ? combien de temps met le son à s'arrêter ? une note reste-t-elle tenue ? · **Si échec (= attendu) :** notez le délai du panic, le nombre de notes restées tenues, et la trame d'erreur reçue. **C'est la mesure qui ferme F-07 sur matériel réel** — elle vaut à elle seule la session.
- [ ] **HW-F05-01 · Horloge MIDI** — activez l'horloge pour l'appareil (`midi_clock_toggle`, ou `midi_clock_enabled` dans ses réglages), jouez à 120 BPM pendant 60 s, capturez la boucle.
      **Critère :** **2 880 ± 5 impulsions** sur 60 s (24 PPQN × 2 noires/s, `MidiClockGenerator.js:23`), dérive < 0,2 % · **Mesure :** `aseqdump -p <port> | grep -c "Clock"` sur une fenêtre chronométrée · **Si échec :** notez le compte réel et la dérive.
- [ ] **HW-F05-02 · Start / Stop / Continue** — démarrez, mettez en pause, reprenez, arrêtez.
      **Critère :** `0xFA` (Start) au démarrage, `0xFC` (Stop) à l'arrêt, la reprise ne réémet pas un Start intempestif · **Mesure :** `aseqdump` · **Si échec :** collez la séquence observée.

---

## 6. Session 4 — UART / GPIO à 31 250 baud (≈ 45 min, un fil)

**Sections :** M · **Palier 1**
**Matériel minimum :** un seul fil de liaison entre **GPIO14 (broche 8, TX)** et
**GPIO15 (broche 10, RX)**. Aucun composant, aucune soudure : le Pi se parle à
lui-même en 3,3 V, ce qui est parfaitement sûr et suffit à valider le débit, le
cadrage, le running status, le SysEx et la contre-pression.
**Matériel complet (HW-M-07/08) :** un HAT MIDI (Domoshop Slim, OSA — tous deux
sur UART0) ou le circuit DIY opto-isolé 6N138 décrit dans
`docs/GPIO_MIDI_WIRING.md`, plus un instrument DIN réel.
**Variante réduite :** le fil seul ferme M-01 → M-06, soit l'essentiel.

> **Point d'observation.** Contrairement à l'USB, le port série est **ouvert en
> exclusivité par l'application** : vous ne pouvez pas l'écouter en parallèle
> avec un autre outil. L'observation se fait donc par l'application elle-même —
> événements `midi_event` dans l'UI et logs en niveau `debug`.

- [ ] **HW-M-01 · UART configuré au bon débit** — `enable_uart=1` dans `config.txt` ; sur **Pi 3B+ / Zero 2W**, `dtoverlay=disable-bt` est **obligatoire** (le mini-UART est instable à 31 250 baud, `docs/GPIO_MIDI_WIRING.md`) ; sur Pi 4/5, préférez `dtoverlay=uart2..5` pour garder le Bluetooth. Puis `sudo usermod -aG dialout $USER` et reboot.
      **Critère :** `stty -F /dev/ttyAMA0 31250 && stty -F /dev/ttyAMA0 -a | head -1` affiche **exactement** `speed 31250 baud` · **Mesure :** les deux commandes · **Si échec :** beaucoup de pilotes arrondissent silencieusement à 38 400 — notez la vitesse réellement rapportée, c'est la cause n°1 de « les notes sont corrompues ».
- [ ] **HW-M-02 · Le module Serial MIDI ouvre le port** — Réglages → Serial MIDI → Scan → ouvrir `/dev/ttyAMA0`.
      **Critère :** `serial_status` montre le port ouvert **et** `/api/capabilities` passe `serial` à `ready` · **Mesure :** les deux · **Si échec :** `Permission denied` → groupe `dialout` non appliqué (il faut un vrai reboot, pas juste une reconnexion).
- [ ] **HW-M-03 · Boucle TX→RX** — fil en place, envoyez une note vers l'instrument série.
      **Critère :** la même note rentre en `midi_event` en **< 20 ms** [proposé] · **Mesure :** UI / log en `debug` · **Si échec :** rien ne revient → vérifiez l'inversion TX/RX ; des octets corrompus → vérifiez la vitesse (M-01).
- [ ] **HW-M-04 · Running status sur flux réel** — jouez un passage dense (arpèges soutenus, 2 min) : le flux sortant utilisera le running status.
      **Critère :** **aucune note bloquée** à la fin, aucune note fantôme · **Mesure :** à l'arrêt, déclenchez un `midi_panic` et écoutez : s'il change quelque chose, c'est qu'une note était restée tenue · **Si échec :** notez la note et le canal restés tenus, et extrayez 200 lignes de log `debug` autour.
- [ ] **HW-M-05 · Saturation du débit** — 31 250 baud 8N1 = 3 125 octets/s ≈ **1 040 messages de 3 octets par seconde**, soit ≈ 0,96 ms par message. Jouez un fichier qui dépasse volontairement ce débit sur un seul port.
      **Critère :** la file d'écriture (**1 024 messages**, `SerialMidiManager.js:31`) ne déborde pas silencieusement : soit elle absorbe, soit le log **le dit** · **Mesure :** cherchez un avertissement de file pleine dans les logs ; relevez le débit du fichier (messages/s) · **Si échec :** notez le débit à partir duquel ça casse — c'est la limite physique à documenter, pas un bug.
- [ ] **HW-M-06 · SysEx sur série** — `sysex_identity_request` vers l'instrument série.
      **Critère :** réponse d'identité analysée, **ou** timeout propre à **5 000 ms** (`DeviceManager.js:63`) sans que le port se bloque · **Mesure :** la réponse de la commande + un envoi de note **après** le timeout, qui doit toujours passer · **Si échec :** notez si le port reste inutilisable après le timeout (c'est le cas grave).
- [ ] **HW-M-07 · Instrument DIN réel** *(matériel supplémentaire : HAT ou circuit 6N138 + instrument)* — branchez, jouez une gamme.
      **Critère :** toutes les notes sonnent, justes, dans l'ordre, sans décalage · **Mesure :** à l'oreille + log · **Si échec :** la section Troubleshooting de `docs/GPIO_MIDI_WIRING.md` donne les trois causes : inversion TX/RX, masse non commune, 6N138 non alimenté (broche 8).
- [ ] **HW-M-08 · Deux UART simultanés** *(Pi 4/5)* — activez `uart2` et `uart3`, ouvrez les deux ports, jouez un fichier à deux instruments.
      **Critère :** chaque port ne reçoit que son propre flux, aucune diaphonie · **Mesure :** un instrument (ou une boucle) par port · **Si échec :** notez quel port reçoit quoi.
- [ ] **HW-M-09 · Le conflit BLE ↔ UART est documenté sur cette machine** — voir **F-169**.
      **Critère :** vous savez, et vous notez, dans quel mode tourne cette boîte. Sur Pi 3B+ / Zero 2W, `disable-bt` (requis pour §M) **supprime le BLE** : §L et §M sont mutuellement exclusifs sur ces modèles · **Mesure :** `dtoverlay -l` + `hciconfig` · **Si échec :** ce n'est pas un échec, c'est un arbitrage — notez-le dans le journal, il conditionne la session 5.

---

## 7. Session 5 — BLE MIDI (≈ 35 min, un smartphone)

**Sections :** L · **Palier 1**
**Matériel minimum :** un smartphone avec une application BLE-MIDI gratuite en
mode périphérique. **Aucun instrument DIY nécessaire.**
**Alternative :** un ESP32 avec un croquis BLE-MIDI — c'est aussi le substitut
naturel d'un instrument maison pour la session 9.
**Prérequis :** `GMBOOP_BLE_ENABLED=true` (ou `ble.enabled` dans `config.json`),
D-Bus disponible, et **le Bluetooth non désactivé par la session 4** (HW-M-09).

- [ ] **HW-L-01 · La pile BLE s'initialise** — redémarrez le service, lisez les logs de démarrage.
      **Critère :** aucun `Failed to initialize Bluetooth` · **Mesure :** `journalctl -u gmboop -n 100 | grep -i bluetooth` · **Si échec :** collez la ligne. ⚠️ **Ne vous fiez pas à `ble: ready` dans `/api/health`** : F-02 dit qu'il peut apparaître après un échec d'init. La seule preuve est HW-L-02.
- [ ] **HW-L-02 · Scan** — modale Bluetooth → Scan, smartphone en mode périphérique visible.
      **Critère :** le périphérique apparaît dans la fenêtre de scan · **Mesure :** la liste retournée par `ble_scan_start` · **Si échec :** notez la durée réelle du scan. La durée par défaut est de **5 s** (`BluetoothCommands.js:51`) et **non** les 10 000 ms de `config.json` — voir F-164 ; relancez avec `{"duration":15}` avant de conclure à une panne radio.
- [ ] **HW-L-03 · Connexion et appairage** — connectez.
      **Critère :** connexion établie en **< 10 s** [proposé], `ble_status` la confirme, `ble_paired` la liste · **Mesure :** chronomètre + les deux commandes · **Si échec :** notez à quelle étape ça bloque (découverte / connexion / abonnement aux notifications).
- [ ] **HW-L-04 · Notes de bout en bout** — jouez du clavier virtuel vers le périphérique BLE, puis, si l'application le permet, du périphérique vers GMB.
      **Critère :** les notes passent **dans les deux sens**, sans note fantôme · **Mesure :** l'application du smartphone + les `midi_event` côté GMB · **Si échec :** notez le sens qui échoue ; le codec de paquets BLE (en-tête d'horodatage 13 bits) est déjà couvert par des tests unitaires, donc un échec ici pointe la machine à états de connexion, pas le codec.
- [ ] **HW-L-05 · Latence et gigue radio** — envoyez 100 notes à 4 Hz.
      **Critère :** latence médiane **≤ 30 ms**, gigue (p95 − p50) **≤ 15 ms** [proposé — aucun seuil BLE n'existe dans le projet, cf. F-168] · **Mesure :** micro + Audacity sur le son du smartphone, ou l'horodatage de l'application réceptrice · **Si échec :** relevez médiane, p95, max et la distance Pi ↔ périphérique.
- [ ] **HW-L-06 · Perte de portée et reconnexion** — éteignez le périphérique ou éloignez-vous.
      **Critère :** tentatives de reconnexion à ≈ **2, 4, 8, 16, 30 s** (`BluetoothManager.js:168`) visibles en log ; rallumé dans la fenêtre, il se reconnecte seul · **Mesure :** `journalctl -u gmboop -f | grep BLE` avec l'heure · **Si échec :** collez la séquence de tentatives observée.
- [ ] **HW-L-07 · Épuisement des tentatives** — laissez le périphérique éteint plus de 2 min.
      **Critère :** log `giving up reconnection to <addr> after 5 attempts` (`_maxReconnectAttempts = 5`, `BluetoothManager.js:50`), UI cohérente, **et RSS stable** (pas de fuite de handles) · **Mesure :** le log + `curl -s /api/metrics | grep rss` avant/après · **Si échec :** notez la croissance de RSS et si des timers restent actifs (rallumez : y a-t-il une reconnexion tardive ?).
- [ ] **HW-L-08 · Deux périphériques BLE simultanés** *(un second smartphone ou un ESP32)*.
      **Critère :** les deux connectés, adressables séparément, aucune perte de note sur l'un quand l'autre joue · **Mesure :** `ble_paired` + jeu croisé · **Si échec :** notez lequel décroche et à partir de combien de notes/s.

---

## 8. Session 6 — Navigateur, audio, écran tactile (≈ 50 min)

**Sections :** P01–P04, S, AL · **Palier 1**
**Matériel :** une tablette tactile (ou un smartphone) **et** un poste avec
Chromium/DevTools sur le même réseau. Un casque ou des enceintes.
**Variante réduite :** le navigateur du poste seul ferme P01–P04 et AL ; §S
(multitouch) exige impérativement un vrai écran tactile — c'est précisément ce
qu'un test jsdom ne peut pas simuler.

- [ ] **HW-AL-01 · Temps jusqu'à interactif après reboot** — Pi redémarré, cache navigateur vidé, chargez la SPA.
      **Critère :** interactif en **< 4 s** [doc : `V0.9_ROADMAP.md` §T9.3] · **Mesure :** onglet Performance des DevTools, ou `performance.timing` dans la console · **Si échec :** notez le temps et la ressource la plus lente de la cascade réseau.
- [ ] **HW-P01-01 · Synthèse navigateur** — piano GM 0, jouez un accord de 6 notes.
      **Critère :** 6 voix simultanées audibles, sans craquement, note off propre · **Mesure :** à l'oreille + `dmesg | grep -i xrun` · **Si échec :** notez le nombre de voix réellement entendues et la présence de XRUN.
- [ ] **HW-P01-02 · Polyphonie, changement de programme, pitch bend, batterie** — tenez 16 notes ; changez de programme en cours de jeu ; molette de pitch ; kit de batterie sur le canal 9.
      **Critère :** 16 notes tenues sans décrochage ; le changement de programme s'entend à la note suivante ; le pitch bend est continu ; le canal 9 sonne percussif · **Mesure :** à l'oreille · **Si échec :** notez lequel des quatre échoue.
- [ ] **HW-P02-01 · SoundFont changée en cours de lecture** — changez de SF2 pendant qu'un fichier joue.
      **Critère :** aucun crash, aucun silence définitif ; le timbre change au plus tard à la note suivante · **Mesure :** à l'oreille + console navigateur (0 erreur) · **Si échec :** collez les erreurs de console.
- [ ] **HW-P03-01 · Preview « original » ≠ preview « adapté »** — **la vérification la plus importante de cette session.** Choisissez un fichier que l'adaptation modifie visiblement (une note hors tessiture, donc transposée). Écoutez l'original, puis l'adapté.
      **Critère :** les deux **diffèrent à l'oreille, exactement comme le rapport d'adaptation l'annonce** · **Mesure :** écoute A/B + le rapport d'adaptation affiché · **Si échec :** s'ils sonnent **identiques**, la preview lit la mauvaise source de données — et **tout jugement porté sur la qualité de l'adaptation depuis l'interface est faux**. Notez le fichier, la note concernée, et ce que dit le rapport. C'est l'avertissement explicite de `14_AUDIO.md` §P03.
- [ ] **HW-P04-01 · Mémoire audio** — 20 cycles de changement (morceau + SoundFont), snapshot de heap avant/après avec GC forcé.
      **Critère :** croissance résiduelle **< 50 Mo** sur 20 cycles [proposé] · **Mesure :** DevTools → Memory → Heap snapshot, bouton « collect garbage » entre les deux · **Si échec :** notez la croissance et exportez le snapshot final (les objets retenus sont typiquement des `AudioBuffer`).
- [ ] **HW-S-01 · Une frappe = une note** *(tablette)* — piano GM 0, une seule tape brève.
      **Critère :** **exactement** un note-on et un note-off, aucune note fantôme · **Mesure :** moniteur MIDI de l'UI ou `aseqdump` sur la sortie · **Si échec :** notez le nombre d'événements réellement émis (un doublon trahit un double binding pointer/touch).
- [ ] **HW-S-02 · Multitouch à 5 doigts** *(tablette)* — accord de 5 notes posé puis relâché d'un coup.
      **Critère :** 5 note-on **et** 5 note-off, les bonnes notes · **Mesure :** idem · **Si échec :** notez combien de notes manquent à l'aller et au retour. C'est **la** vérification que seul un vrai écran tactile peut faire.
- [ ] **HW-S-03 · Roulement de batterie — reproduction de F-07 côté UI** *(tablette)* — sur le drum pad, 10 frappes/seconde pendant 10 s (soit ≈ 20 trames WS/s, puis montez à 2 doigts pour dépasser 60).
      **Critère attendu : ÉCHEC au-delà de 60 événements/s.** Chaque note = une trame (`KeyboardEvents.js:497,524`) et le plafond est de 60 msg/s par connexion (`WebSocketServer.js:47`) ; **une trame en excès est jetée avant dispatch — un note-off jeté laisse une note qui sonne** · **Mesure :** comptez les événements reçus vs frappés ; écoutez si une note reste tenue · **Si échec (= attendu) :** notez le nombre d'événements perdus et le nombre de notes restées tenues.
- [ ] **HW-S-04 · Glissando sur la vue manche** *(tablette)* — balayez rapidement la vue fretboard.
      **Critère :** même analyse que S-03 · **Mesure :** idem · **Si échec :** notez le seuil de vitesse à partir duquel des notes se perdent.
- [ ] **HW-S-05 · Checklist visuelle du modal piano** — la liste du `TODO.md` : piano GM 0 → guitare GM 24 (vue manche, accord majeur) → kit batterie canal 9 (drumpad) → sax GM 65 (piano-slider + panneau souffle) → vue liste → octave ±, minimap, zoom → molette de modulation + pitch bend.
      **Critère :** les 7 étapes s'affichent et jouent correctement · **Mesure :** visuel + oreille · **Si échec :** notez l'étape et faites une capture d'écran.
- [ ] **HW-S-06 · Fuite mémoire du modal** — ouvrez/fermez le modal piano **10 fois**, GC forcé, snapshot avant/après.
      **Critère :** résidu **< 20 Mo** après 10 cycles [proposé] · **Mesure :** DevTools Memory · **Si échec :** exportez le snapshot ; cherchez les listeners non détachés.
- [ ] **HW-S-07 · Les trois grandes modales en portrait** *(tablette)* — RoutingSummary, InstrumentSettings (ISMSections), KeyboardPiano.
      **Critère :** **aucun défilement horizontal du corps de page**, tous les boutons atteignables au pouce · **Mesure :** visuel · **Si échec :** capture d'écran de chaque modale fautive, en précisant la résolution de la tablette.

---

## 9. Session 7 — Latence acoustique réelle (≈ 60 min, micro requis)

**Sections :** O · **Palier 2**
**Matériel :** un micro USB (ou une carte son avec entrée micro) placé près de
l'instrument, et **au moins deux instruments réels sonnants** aux latences
différentes — idéalement un mécanique (lent) et un synthé (rapide).
**Variante réduite :** avec **un seul** instrument, HW-O-01 → O-05 restent
faisables ; l'alignement d'ensemble (O-06, O-07), qui est le cœur de la
section, exige deux instruments minimum.

> **Ce que mesure quoi.** La compensation totale appliquée à un événement est la
> **somme** de deux sources (`CompensationService.js:113-127`) :
> 1. le `sync_delay` par instrument — c'est ce que la **modale de calibration**
>    écrit, via le chemin micro (`calibrate_delay`) ;
> 2. le profil matériel de `LatencyCompensator` (table `instruments_latency`) —
>    **inaccessible depuis l'interface** (F-166), il faut la commande WS.
>
> Si vous ne validez que la modale, vous ne validez que la moitié du mécanisme.

- [ ] **HW-O-01 · Le micro est vu** — modale de calibration, liste ALSA.
      **Critère :** le micro apparaît dans la liste déroulante · **Mesure :** `calibrate_list_alsa_devices` ou `arecord -l` · **Si échec :** collez `arecord -l` et le contenu de la liste.
- [ ] **HW-O-02 · VU-mètre et seuil de détection** — lancez le monitoring, frappez une note.
      **Critère :** au repos le RMS reste **sous** le seuil, une note frappée le dépasse nettement. Le défaut est **0,02** (`DelayCalibrator.js:48`), plage admise 0,01–0,10 · **Mesure :** le VU-mètre + la valeur du curseur · **Si échec :** **notez la valeur de seuil que vous avez dû mettre** — c'est une donnée de réglage réutilisable, pas un échec.
- [ ] **HW-O-03 · Calibration d'un instrument** — 5 mesures (défaut).
      **Critère :** **confiance ≥ 80 %**, ce qui équivaut à un écart-type ≤ 10 ms (la formule est `100 − (stdDev/50)×100`, `DelayCalibrator.js:132`) · **Mesure :** relevez `delay`, `mean`, `stdDev`, `confidence` · **Si échec :** notez les 5 mesures brutes ; un écart-type élevé signale un micro mal placé ou un seuil trop bas (bruit détecté comme attaque).
- [ ] **HW-O-04 · Répétabilité** — refaites trois fois la même calibration.
      **Critère :** les trois médianes s'accordent à **± 5 ms** (le projet lui-même considère l'écart-type < 5 ms comme la confiance maximale) · **Mesure :** les trois valeurs · **Si échec :** notez l'étendue ; au-delà de 10 ms la compensation n'est pas fiable et O-06 n'a pas de sens.
- [ ] **HW-O-05 · La valeur atterrit bien dans les réglages** — bouton « Appliquer les délais ».
      **Critère :** `instrument_get_settings` renvoie le `sync_delay` mesuré pour le bon couple (device, canal) · **Mesure :** la commande, ou la fiche instrument dans l'UI · **Si échec :** notez la valeur écrite vs la valeur mesurée.
- [ ] **HW-O-06 · Alignement acoustique à deux instruments — le vrai critère** — calibrez les deux, routez-les sur le même unisson, enregistrez au micro.
      **Critère :** écart entre les attaques des deux instruments **≤ 15 ms** [proposé — le projet ne fixe aucun seuil, cf. F-168 ; 10–20 ms est la limite usuelle de perception d'un ensemble « serré »] · **Mesure :** ouvrez l'enregistrement dans Audacity, zoomez sur la première attaque, lisez l'écart entre les deux transitoires · **Si échec :** notez l'écart, les deux `sync_delay`, et **joignez l'extrait audio** — c'est la pièce qui permet d'analyser à distance.
- [ ] **HW-O-07 · Un instrument lent (> 100 ms)** — si vous avez un mécanique (piano à solénoïdes, mécanisme de pincement), calibrez-le.
      **Critère :** malgré un `sync_delay` supérieur à `playback.lookahead` (**100 ms**, `config.json`), la note arrive à l'heure. Le code étend dynamiquement la fenêtre (`PlaybackScheduler.js:534-548` ajoute `maxCompSec` à la cible), donc c'est censé marcher — **cette vérification confirme que ça marche pour de vrai** · **Mesure :** enregistrement micro, écart d'attaque avec un instrument rapide · **Si échec :** notez le `sync_delay`, la fenêtre effective, et si la note arrive **en retard** (compensation non appliquée à temps) ou **en avance** (sur-compensation).
- [ ] **HW-O-08 · Le scénario titre : plusieurs instruments, latences différentes** — 4 minimum, 16 dans l'idéal.
      **Critère :** étendue des attaques sur un unisson **≤ 20 ms** [proposé] · **Mesure :** enregistrement micro, mesurez la paire la plus écartée · **Si échec :** notez la paire fautive et leurs deux `sync_delay`.
- [ ] **HW-O-09 · Recommandations de recalibration** — `latency_recommendations` (commande WS, pas d'UI).
      **Critère :** les appareils jamais calibrés remontent en `reason:"missing"`, ceux de plus de 7 jours en `reason:"outdated"` (`LatencyCompensator.js:21`) · **Mesure :** la commande · **Si échec :** notez la sortie ; attention, la valeur `latency.recalibrationDays` de `config.json` **n'est pas lue** (F-164), le 7 est codé en dur.

---

## 10. Session 8 — Synchronisation MIDI ↔ lumière (≈ 40 min)

**Sections :** AC · **Palier 2**
**Matériel :** un bandeau LED WS2812 sur GPIO, **ou** un contrôleur WLED sur le
réseau (le plus simple : une ESP8266/ESP32 WLED à 15 €). Un smartphone capable
de filmer en **240 fps** (slow-motion) — 1 image = 4,2 ms, c'est suffisant et ça
remplace le photodiode.
**Prérequis strict :** *« cette mesure n'a aucun sens tant que AB01–AB07
n'établissent pas que le pipeline est correct »* (`15_LIGHTING.md` §AC). Le
module lighting est à **2,35 % de couverture** (F-13, P1). **Attendez le
rapport du lot L02 avant de conclure quoi que ce soit ici** — mais faites
quand même HW-AC-02, qui est un test de sécurité, pas de justesse.

- [ ] **HW-AC-01 · Un driver pilote du vrai matériel** — `lighting_device_test`.
      **Critère :** le bandeau s'allume · **Mesure :** visuel · **Si échec :** notez le driver, sa config, et le message d'erreur retourné.
- [ ] **HW-AC-02 · Le chemin MIDI survit à un driver muet — le risque n°1** — pendant une lecture dense, coupez le réseau du contrôleur WLED (débranchez son alimentation, ou bloquez son IP).
      **Critère :** **aucun avertissement `system_lag`** (seuil 50 ms, `EventLoopMonitor.js:30`) et la lecture ne décroche pas · **Mesure :** `journalctl -u gmboop -f | grep -i "event loop lag"` + écoute · **Si échec :** notez la valeur de lag rapportée et le driver concerné. Les règles lumière sont **évaluées de façon synchrone sur le chemin MIDI** : un driver lent bloque la musique. C'est la vérification la plus importante de la session.
- [ ] **HW-AC-03 · Décalage MIDI ↔ lumière** — filmez en 240 fps l'instrument **et** la LED dans le même cadre ; jouez une note forte isolée.
      **Critère :** décalage **≤ 40 ms** [proposé — cf. F-168 ; ≈ 10 images à 240 fps] · **Mesure :** comptez les images entre la transitoire audio (visible sur la piste son du clip) et l'allumage · **Si échec :** notez le nombre d'images, le sens du décalage (lumière en avance ou en retard) et **joignez le clip**.
- [ ] **HW-AC-04 · Retour à un état sûr** — `system_restart` (ou Ctrl-C) alors que les lumières sont allumées.
      **Critère :** toutes les LED éteintes en **≤ 2 s** [proposé] · **Mesure :** chronomètre · **Si échec :** un bandeau resté allumé après l'arrêt du service est un défaut à signaler tel quel (§C02).
- [ ] **HW-AC-05 · Charge : règles activées pendant l'orchestre** — activez toutes vos règles lumière, rejouez le fichier dense de la session 2.
      **Critère :** `npm run bench` **relancé pendant** cette lecture doit garder `playback-jitter p99 < 5 ms` · **Mesure :** comparez avec la valeur relevée en HW-F03-01 · **Si échec :** notez les deux p99 (sans / avec lumière). C'est la dégradation que `22_HARDWARE_VALIDATION.md` demande explicitement de surveiller (F-13).

---

## 11. Session 9 — Matrice d'instruments réels (≈ 60 min)

**Sections :** BL, BJ · **Palier 2**
**Matériel :** ce que vous avez. Une ligne par instrument, une colonne par
transport. **La matrice partielle vaut mieux que la matrice vide** : remplissez
ce que vous pouvez, laissez `—` ailleurs.
**Variante réduite :** un instrument du commerce + un ESP32 couvrent déjà deux
lignes sur quatre.

Pour **chaque** instrument, les cinq mêmes vérifications :

- [ ] **HW-BL-<n>-a · Détection** — **Critère :** apparaît ≤ 10 s après branchement · **Mesure :** UI + log · **Si échec :** `device_list` complet.
- [ ] **HW-BL-<n>-b · Identité** — `sysex_identity_request`. **Critère :** identité reconnue **et estampillée sur tous les canaux du device** (comportement livré en T1.9), ou timeout propre à 5 000 ms · **Mesure :** la fiche instrument + la base · **Si échec :** notez la réponse brute. Rappel : GMB n'implémente aujourd'hui que le **consommateur d'identité v1** (52 octets) — la spec v2 de `docs/SYSEX_IDENTITY.md` précède le code (§12 de ce document), un firmware v2 n'est donc pas censé être reconnu.
- [ ] **HW-BL-<n>-c · Gamme de do majeur sur toute la tessiture** — **Critère :** toutes les notes sonnent, justes, aucune manquante, aucune doublée · **Mesure :** oreille · **Si échec :** notez les notes manquantes (bornes de tessiture mal déclarées ?).
- [ ] **HW-BL-<n>-d · CC et pitch bend** — molette de modulation, pitch bend, volume.
      **Critère :** chacun produit un effet audible · **Mesure :** oreille · **Si échec :** notez lequel est inerte — c'est le symptôme d'une capacité déclarée mais non consommée (croisez avec le lot L06).
- [ ] **HW-BL-<n>-e · Panic + 5 min de jeu continu** — **Critère :** le panic fait taire l'instrument ; après 5 min de jeu, **aucune note bloquée** · **Mesure :** oreille + panic de contrôle en fin de test · **Si échec :** notez la note bloquée et le contexte.

Matrice à reporter (une croix par cellule validée) :

| Classe d'instrument | USB | BLE | DIN/UART | RTP |
|---|---|---|---|---|
| Instrument du commerce | ☐ | ☐ | ☐ | ☐ |
| ESP32 DIY | ☐ | ☐ | ☐ | ☐ |
| Arduino MIDI | ☐ | n/a | ☐ | n/a |
| Instrument mécanique GMB | ☐ | ☐ | ☐ | ☐ |

- [ ] **HW-BJ-01 · RTP-MIDI face à un vrai pair** — un Mac ou un iPad avec Network MIDI, ou `rtpmidid` sur une autre machine.
      **Critère attendu : ÉCHEC PARTIEL, et c'est correct.** Le projet **se déclare lui-même `degraded`** (`Application.js:719-725` : pas d'invitation IN/OK, pas de synchro CK, pas de journal) et le README le dit en toutes lettres · **Mesure :** notez ce qui se passe réellement — pas de session du tout, session établie mais notes perdues, ou fonctionnement · **Si échec :** c'est la **preuve que la déclaration `degraded` est honnête** ; si au contraire ça marche parfaitement, notez-le aussi, c'est une information utile.

---

## 12. Session 10 — Qualité musicale (≈ 60 min, deux paires d'oreilles)

**Sections :** BM · **Palier 2**
**Matériel :** l'orchestre, ou à défaut une bonne écoute et le rendu audio du
navigateur. **Deux auditeurs minimum** — c'est le protocole demandé par
`22_HARDWARE_VALIDATION.md` §BM.
**Prérequis :** un corpus stable de fichiers de référence (le « golden-file
corpus » proposé par `07_ADAPTATION.md`). Sans corpus figé, vous notez une
cible mouvante et la session n'est pas reproductible.

Corpus minimum suggéré : 6 fichiers — piano solo, orchestral, très rythmique,
chanson à mélodie forte, jazz (harmonie dense), et un fichier volontairement
trop dense pour votre parc.

Pour **chaque** fichier, écoute A/B (source vs adapté), notation **1 à 5** par
les deux auditeurs sur sept critères :

- [ ] **HW-BM-<n>-1 · Mélodie préservée** — la ligne principale reste identifiable et au premier plan.
- [ ] **HW-BM-<n>-2 · Basse préservée** — le fondement harmonique n'a pas disparu ni sauté d'octave de façon incongrue.
- [ ] **HW-BM-<n>-3 · Rythme** — pas de décalage perceptible, pas de note en avance ou en retard.
- [ ] **HW-BM-<n>-4 · Harmonie** — les accords restent des accords ; pas de dissonance introduite par l'adaptation.
- [ ] **HW-BM-<n>-5 · Conduite des voix** — pas de saut d'octave brutal au milieu d'une phrase.
- [ ] **HW-BM-<n>-6 · Collisions** — deux voix ne se disputent pas la même note sur le même instrument.
- [ ] **HW-BM-<n>-7 · Notes perdues** — le compte de notes perdues annoncé par le rapport d'adaptation correspond à ce qu'on entend.

**Critère global :** moyenne des deux auditeurs **≥ 3,5/5** sur chaque critère,
et **aucun critère sous 2** sur aucun fichier [proposé].
**Mesure :** une grille 6 fichiers × 7 critères × 2 auditeurs, reportée telle
quelle dans le journal.
**Si échec :** notez le fichier, le critère, le passage (minutage) et
**exportez le fichier adapté** — c'est ce qui permet de rejouer le diagnostic
sans matériel.

---

## 13. Session 11 — Validation orchestre (≈ 90 min) — le vrai test système

**Sections :** BX · **Palier 2**
**Matériel :** 8 à 16 instruments, transports **mélangés** (USB + BLE + UART),
plusieurs familles, lumière activée, tablette connectée en supervision.
**Variante réduite (fortement recommandée si vous n'avez pas l'orchestre) :**
**3 sorties suffisent** — 1 USB réel, 1 BLE (le smartphone de la session 5),
1 UART (la boucle de la session 4). Le point du test n'est pas le nombre, c'est
le **mélange de transports sous charge prolongée**. Une session à 3 transports
vaut infiniment plus qu'une session jamais faite à 16.

**Prérequis :** sessions 3, 4, 5 et 7 passées. Lancez-la en fin de journée,
après avoir tout relevé — c'est celle qui coûte le plus cher à recommencer.

**Protocole :** un fichier MIDI complexe (≥ 8 canaux actifs), assignation
automatique, adaptation automatique, compensation de latence appliquée, lumière
activée, tablette ouverte sur la page de supervision, **lecture continue ≥ 30
minutes** (idéalement en boucle).

Relevés **avant** de lancer, puis toutes les 10 minutes :

- [ ] **HW-BX-01 · Notes bloquées** — **Critère : 0** · **Mesure :** à la fin, un `midi_panic` ne doit **rien** changer au silence · **Si échec :** notez combien, sur quel instrument, à quel moment, et si un passage dense précédait.
- [ ] **HW-BX-02 · Notes perdues ou doublées** — **Critère :** < 0,1 % des notes du fichier [proposé] · **Mesure :** comparez le compte d'événements émis (logs `debug`) au compte du fichier · **Si échec :** notez le taux et le canal le plus touché.
- [ ] **HW-BX-03 · Jitter noyau pendant l'orchestre** — `cyclictest` en parallèle.
      **Critère :** Max **< 2 ms** [doc] · **Mesure :** relevez Max · **Si échec :** comparez avec HW-AD-09 (même mesure, sans orchestre) — l'écart est le coût réel de l'orchestre.
- [ ] **HW-BX-04 · Charge CPU** — **Critère :** load average à 1 min **< 2,0** sur un quadricœur [proposé] · **Mesure :** `uptime` · **Si échec :** `top -H -p $(pgrep -f "node.*server.js")` pour voir quel thread brûle.
- [ ] **HW-BX-05 · Mémoire** — **Critère :** croissance de RSS **< 100 Mo sur 30 min** [proposé] · **Mesure :** `curl -s /api/metrics | grep rss` toutes les 10 min · **Si échec :** les 4 relevés et la pente.
- [ ] **HW-BX-06 · Température** — **Critère :** **< 80 °C** et `get_throttled` = `0x0` en fin de test · **Mesure :** relevé toutes les 10 min · **Si échec :** la courbe et la valeur de `get_throttled`.
- [ ] **HW-BX-07 · Santé WebSocket** — **Critère :** `gmboop_websocket_clients` stable, aucune déconnexion de la tablette · **Mesure :** `/api/metrics` + la tablette elle-même · **Si échec :** notez l'heure des déconnexions et corrélez avec les passages denses.
- [ ] **HW-BX-08 · Erreurs** — **Critère :** **0** ligne `ERROR` pendant la fenêtre · **Mesure :** `grep -c ERROR logs/gmboop.log` avant/après · **Si échec :** collez les 10 premières lignes `ERROR` distinctes.
- [ ] **HW-BX-09 · Lumière sous charge** — **Critère :** aucun `system_lag` déclenché, aucune dégradation de timing audible quand les règles sont actives · **Mesure :** log + oreille · **Si échec :** relancez 5 min **avec lumière désactivée** et comparez : c'est la mesure qui isole F-13.
- [ ] **HW-BX-10 · Le panic de scène** — au milieu du passage le plus dense, appuyez sur le panic depuis la tablette.
      **Critère :** silence complet en **< 500 ms** [proposé] · **Mesure :** chronomètre · **Si échec :** **c'est le scénario que F-07 prédit** : le panic partage le plafond de 60 msg/s avec le trafic de l'UI. Notez le délai et si des notes restent tenues. Si ce point échoue, il devient le blocker n°1 avant toute utilisation en public.
- [ ] **HW-BX-11 · Arrêt propre en pleine lecture** — `system_restart` sans arrêter la lecture d'abord.
      **Critère :** tous les instruments silencieux en **≤ 2 s**, lumières éteintes, service revenu · **Mesure :** oreille + chronomètre · **Si échec :** notez ce qui reste allumé ou sonnant.

---

## 14. Session 12 — Régression multi-modèles (optionnelle, ≈ 30 min par modèle)

**Sections :** BT · **Palier 2**
**Matériel :** au moins deux modèles de Pi (3B+ et 4, ou 4 et 5).
**Variante réduite :** un seul modèle — mais **notez lequel**, car sans cette
mention tous les chiffres de ce document sont ininterprétables.

Rejouez **uniquement** : HW-AD-08, HW-AD-09, HW-F03-01, HW-F03-02, HW-AD-10.

- [ ] **HW-BT-01 · Pi 3B+** — la contrainte limitante. Notez les 5 mesures.
      **Critère :** *« une optimisation Pi 5 ne doit pas rendre le Pi 3 inutilisable »* — le Pi 3B+ est donc la référence de performance. Pensez au plafond de tas : `NODE_HEAP_MB=256` (`ecosystem.config.cjs`). ⚠️ **L'unité systemd écrite par `Install.sh` ne fixe aucun plafond de tas** — c'est le chemin par défaut sur Pi, et il ignore le dimensionnement documenté (F-167).
- [ ] **HW-BT-02 · Pi 4** — les 5 mêmes mesures.
- [ ] **HW-BT-03 · Pi 5** — les 5 mêmes mesures.
- [ ] **HW-BT-04 · Comparaison** — **Critère :** aucune régression > 20 % d'un modèle au suivant sur `bench-playback-jitter p99` [proposé] · **Mesure :** le tableau §15.2 · **Si échec :** notez le modèle et la mesure qui décroche.

---

## 15. Tableaux à reporter

### 15.1 État des sessions

| # | Session | Durée | Palier | Sections | Verdict | Date | Opérateur |
|---|---|---|---|---|---|---|---|
| 1 | Pi neuf, installation propre | 45 min | 0 | B01, B03, AD, AG | ☐ | | |
| 2 | Temps réel et plateforme | 40 min | 0 | AD, F03 | ☐ | | |
| 3 | Boucle USB MIDI | 45 min | 1 | K, D05, G04, F05 | ☐ | | |
| 4 | UART / GPIO 31 250 baud | 45 min | 1 | M | ☐ | | |
| 5 | BLE MIDI | 35 min | 1 | L | ☐ | | |
| 6 | Navigateur, audio, tactile | 50 min | 1 | P01–P04, S, AL | ☐ | | |
| 7 | Latence acoustique | 60 min | 2 | O | ☐ | | |
| 8 | Synchronisation lumière | 40 min | 2 | AC | ☐ | | |
| 9 | Matrice d'instruments | 60 min | 2 | BL, BJ | ☐ | | |
| 10 | Qualité musicale | 60 min | 2 | BM | ☐ | | |
| 11 | Validation orchestre | 90 min | 2 | BX | ☐ | | |
| 12 | Régression multi-modèles | 30 min/Pi | 2 | BT | ☐ | | |

Verdict : `PASS` / `PARTIAL` / `FAIL` / `NON FAIT`.

### 15.2 Les 22 chiffres qui constituent la ligne de base matérielle

**C'est le tableau qui compte.** Sans lui, la prochaine session ne peut rien
comparer.

| # | Mesure | Seuil | Origine | Valeur relevée | Modèle de Pi |
|---|---|---|---|---|---|
| 1 | Démarrage au boot → `/api/health` ok | ≤ 90 s | [proposé] | | |
| 2 | TTI de la SPA hors ligne | < 10 s | [proposé] | | |
| 3 | TTI de la SPA après reboot | < 4 s | [doc T9.3] | | |
| 4 | `get_throttled` après 10 min de charge | `0x0` | [code Pi] | | |
| 5 | Température max sous charge | < 80 °C | [proposé] | | |
| 6 | cyclictest Avg au repos | < 10 µs (Pi 4) | [doc realtime-pi] | | |
| 7 | cyclictest Max au repos | < 300 µs (Pi 4) | [doc realtime-pi] | | |
| 8 | cyclictest Max pendant lecture | < 2 ms | [doc realtime-pi] | | |
| 9 | `bench-playback-jitter` p99 | < 5 ms | [code benchmark.js:211] | | |
| 10 | `bench-playback-jitter` p999 | < 15 ms | [code benchmark.js:212] | | |
| 11 | `A.throughput` (perf:load) | ≥ 150 000 ev/s | [code load-soak.js:123] | | |
| 12 | `A.eventloop_p99` | < 50 ms | [code load-soak.js:125] | | |
| 13 | `C.heap_slope` | < 8 Mo/s | [code load-soak.js:216] | | |
| 14 | Détection hot-plug USB | ≤ 10 s | [code DeviceDiscovery.js:38] | | |
| 15 | Aller-retour USB (`latency_measure`) | < 10 ms | [proposé] | | |
| 16 | Impulsions d'horloge sur 60 s à 120 BPM | 2 880 ± 5 | [code MidiClockGenerator.js:23] | | |
| 17 | Débit série avant débordement de file | ≈ 1 040 msg/s | [code SerialMidiManager.js:31] | | |
| 18 | Latence BLE médiane | ≤ 30 ms | [proposé] | | |
| 19 | Confiance de calibration micro | ≥ 80 % | [code DelayCalibrator.js:132] | | |
| 20 | Écart d'attaque acoustique (2 instruments) | ≤ 15 ms | [proposé] | | |
| 21 | Décalage MIDI ↔ lumière | ≤ 40 ms | [proposé] | | |
| 22 | Délai du panic sous charge | < 500 ms | [proposé] | | |

### 15.3 Modèle de rapport d'échec

Un rapport exploitable **à distance, sans matériel** contient exactement ceci :

```
ID           : HW-K-03
Session      : 3 — Boucle USB MIDI
Date / Pi    : 2026-09-14 / Pi 4B 4 Go / Bookworm 64-bit / commit abc1234
Matériel     : interface USB-MIDI <marque/modèle>, boucle DIN OUT→IN
Attendu      : aller-retour médian < 10 ms
Observé      : 34 ms (min 21 / max 68, 5 itérations)
Commande     : latency_measure {"deviceId":"...","iterations":5}
Logs         : 40 lignes autour de l'événement (niveau debug), jointes
Capture      : sortie d'aseqdump / capture d'écran / extrait audio, joints
Reproductible: oui / non — 3 essais sur 3
Note         : le phénomène disparaît quand la lumière est désactivée
```

Les deux dernières lignes sont celles qui font gagner le plus de temps.

---

## 16. Findings ouverts par ce lot

Ces six points ont été trouvés **en rédigeant la procédure** : ce sont des
pièges qui feraient perdre une session entière ou produiraient des mesures
fausses. Ils ne demandent aucun matériel pour être constatés.

### F-164 (P3) — Réglages de configuration liés au matériel, validés mais jamais lus

`src/core/Config.js` valide six clés que **rien ne consomme** :

| Clé | Valeur par défaut | Réalité |
|---|---|---|
| `midi.defaultLatency` | 10 | Aucun lecteur. `docs/INSTALLATION.md:169` la documente pourtant comme *« Default latency compensation in ms »*. |
| `midi.bufferSize` | 1024 | Aucun lecteur. |
| `midi.sampleRate` | 44100 | Aucun lecteur (le calibrateur a son propre 16 kHz, `DelayCalibrator.js:45`). |
| `ble.scanDuration` | 10000 | Aucun lecteur ; la durée réelle est **5 s codées en dur** (`BluetoothCommands.js:51`). |
| `latency.defaultIterations` | 5 | Aucun lecteur ; valeur par défaut du paramètre de méthode. |
| `latency.recalibrationDays` | 7 | Aucun lecteur ; `RECALIBRATION_DAYS = 7` est en dur (`LatencyCompensator.js:21`). |

**Preuve :** `grep -rn "defaultLatency\|bufferSize\|scanDuration" --include=*.js src/`
ne renvoie que `Config.js`.
**Conséquence QA :** un opérateur qui allonge `ble.scanDuration` avant une
session BLE croira que sa radio est en panne (HW-L-02). Un opérateur qui règle
`midi.defaultLatency` croira compenser quelque chose.
**Recommandation :** soit les câbler, soit les retirer de `config.json` **et**
de `docs/INSTALLATION.md`. Croiser avec L13 (capacités mortes).

### F-165 (P3) — La procédure de diagnostic de `realtime-pi.md` ne fonctionne pas

`docs/realtime-pi.md` § Troubleshooting, pour le symptôme *« RSS climbs over
24 h »*, prescrit :

```
curl -s localhost:8080/api/metrics | jq
… watch outputQueue.droppedByClient / bufferedAmount
```

`/api/metrics` renvoie du **texte Prometheus**, pas du JSON (`apiRoutes.js:93`,
`Content-Type: text/plain; version=0.0.4`), et n'expose que `uptime`,
`websocket_clients`, `heap_used`, `rss`, `info`. **Ni `droppedByClient` ni
`bufferedAmount` n'y figurent**, alors que `WsOutputQueue.getStats()` les
calcule (`WsOutputQueue.js:133,223`).
**Conséquence QA :** le symptôme n°1 d'une session de soak (un client lent qui
sature la file de sortie) est **inobservable** en §BX. HW-AD-11 et HW-BX-05 ne
peuvent constater que la croissance, jamais sa cause.
**Recommandation :** exposer `gmboop_ws_output_dropped_total` et
`gmboop_ws_output_buffered_bytes` dans `/api/metrics`, ou corriger la doc.

### F-166 (P2) — La compensation de latence matérielle n'a aucune surface UI

Les huit commandes `latency_measure` / `_set` / `_get` / `_list` / `_delete` /
`_auto_calibrate` / `_recommendations` / `_export` **ne sont appelées par aucun
fichier de `public/`** (vérifié par grep). `docs/API.md:141-145` le documente
honnêtement.

La modale de calibration utilise la famille `calibrate_*` (chemin micro) et
écrit `sync_delay` via `instrument_update_settings`. Or la compensation
appliquée est la **somme** de `sync_delay` **et** du profil matériel de
`LatencyCompensator` (`CompensationService.js:113-127`).
**Conséquence QA :** §O ne peut pas être fermée depuis l'interface. La moitié du
mécanisme de compensation n'est atteignable qu'en WebSocket brut — c'est
pourquoi la session 7 fournit une commande d'appel manuelle.
**Recommandation :** soit exposer la calibration aller-retour dans la modale
existante (elle a déjà la liste des appareils), soit documenter dans l'UI que
seul `sync_delay` est réglable. Croiser avec L01/L13.

### F-167 (P2) — Deux chemins de supervision, et le réglage temps réel n'en couvre qu'un

- `scripts/Install.sh` écrit et **active** une unité systemd `gmboop.service`
  (lignes 417-448), sans `--max-old-space-size`.
- `docs/INSTALLATION.md` et `CLAUDE.md` présentent PM2 comme le mode
  **recommandé** (`npm run pm2:start`), et `ecosystem.config.cjs` est le seul
  endroit qui fixe le plafond de tas dimensionné par modèle (Pi 3 : 256 Mo).
- `scripts/pi-rt-tune.sh` écrit son réglage temps réel dans
  `/etc/systemd/system/gmboop.service.d/realtime.conf` (ligne 219) —
  `CPUAffinity`, `Nice=-15`, `LimitRTPRIO=80`. **Ce fichier est inerte si le
  processus tourne sous PM2.**
- `docs/realtime-pi.md` affirme pourtant : *« When running under PM2 (the
  default), the systemd drop-in handles affinity / nice »*. C'est faux.

**Conséquence QA :** un opérateur qui suit la doc (PM2) puis applique
`pi-rt-tune.sh` mesure un jitter **sans aucun réglage actif**, et
`check-rt-setup.sh` sort quand même en 0 (l'ordonnancement du processus n'est
qu'un `[warn]`). Toute la session 2 devient fausse sans que rien ne le signale.
Risque supplémentaire : deux superviseurs actifs au boot = deux processus sur le
port 8080.
**Mitigation dans ce document :** HW-B03-02 et HW-AD-07 vérifient explicitement
ces deux points **avant** toute mesure.
**Recommandation :** choisir **un** superviseur, l'aligner dans les trois docs,
faire de `node running under SCHED_FIFO` un `[FAIL]` et non un `[warn]` dans
`check-rt-setup.sh`, et fixer le plafond de tas dans l'unité systemd.

### F-168 (P3) — Aucun seuil d'acceptation n'existe pour les trois critères matériels titres

Le projet ne fixe **nulle part** de seuil pour :

| Critère | Section | Seuil proposé ici |
|---|---|---|
| Alignement acoustique des attaques entre instruments | §O | ≤ 15 ms (2 instr.) / ≤ 20 ms (16 instr.) |
| Latence et gigue BLE-MIDI | §L | ≤ 30 ms médiane, ≤ 15 ms de gigue |
| Décalage MIDI ↔ lumière | §AC | ≤ 40 ms |

Ce sont pourtant les trois promesses les plus visibles du produit
(*« les événements doivent arriver acoustiquement ensemble et pas seulement être
envoyés ensemble »*, cité par `14_AUDIO.md`).
**Conséquence QA :** sans seuil, la session 7 produit un chiffre que personne ne
peut qualifier.
**Recommandation :** exécuter la session 7 une fois, constater ce que le
matériel donne réellement, **puis figer les trois seuils dans ce document** et
les traiter en régression.

### F-169 (P2) — BLE et UART MIDI sont mutuellement exclusifs sur Pi 3B+ / Zero 2W, sans avertissement

`docs/GPIO_MIDI_WIRING.md` établit deux faits :

1. sur Pi 3B+ / Zero 2W, le mini-UART (`/dev/ttyS0`) est *« unstable at 31250
   baud »* et il **faut** `dtoverlay=disable-bt` pour utiliser le PL011 ;
2. `disable-bt` désactive le Bluetooth (la doc le note en Troubleshooting :
   *« Bluetooth no longer works — this is expected »*).

Donc sur ces modèles, **activer le MIDI GPIO supprime le MIDI BLE**. Rien dans
l'application ne le signale : le panneau Serial MIDI des réglages propose
l'activation, `/api/capabilities` rapportera `ble: disabled` ou `failed` sans en
donner la cause, et un opérateur peut passer une session entière à croire que sa
radio est morte. Sur Pi 4/5 le conflit se contourne (UART2–5), mais ce n'est
écrit que dans le guide de câblage.
**Recommandation :** afficher l'arbitrage dans le panneau Serial MIDI quand le
modèle détecté est un Pi 3 / Zero 2W, et le mentionner dans
`docs/INSTALLATION.md`.

---

## 17. Ce que ce document ne couvre pas

- **§BN (déterminisme)** est volontairement absent : il ne demande **aucun
  matériel** (lancer le pipeline deux fois dans le même processus et comparer),
  il appartient au lot L05.
- **§BU/BV (acceptation utilisateur, parcours sans documentation)** demandent des
  humains, pas du matériel — hors périmètre de ce lot.
- **§AE (hotspot Wi-Fi)** est matériel mais n'était pas dans le périmètre
  assigné ; il mériterait une session 13 sur le même modèle (activation,
  portail captif, persistance au reboot, conflit avec une connexion Wi-Fi
  existante).
- **Les seuils marqués `[proposé]`** (11 sur 22 dans le tableau §15.2) ne sont
  pas des vérités du projet : ce sont des points de départ. Voir F-168.

## 18. Coordination avec les autres lots

Ce document a été rédigé **avant** que les lots parallèles L03 (parité
transports), L04 (transports), L05 (playback/latence) et L11 (système Pi) ne
déposent leurs rapports : au moment de l'écriture, `docs/audit/2026-09-07/` ne
contenait que `PLAN_AUDITS.md` et `00_BASELINE.md`.

**Ce qu'il reste à intégrer en vague 2**, quand ces rapports existeront :

| Lot | À reprendre ici | Où l'insérer |
|---|---|---|
| **L03** | La liste « ce qui reste strictement matériel » de la matrice de parité transports (mêmes octets → même événement sur USB/BLE/série/RTP) | Session 9, comme colonne supplémentaire de la matrice §11 |
| **L04** | Les cas de hot-plug et de reconnexion **déjà couverts par un énumérateur bouché** — à **retirer** d'ici pour ne pas refaire à la main ce qu'un test automatise | HW-K-04, HW-K-05, HW-G04-* |
| **L05** | Le résultat du harnais de rejeu déterministe et le verdict sur `live ≠ baké` (T3) — s'il reste un écart, la session 10 doit écouter **les deux** | Session 10 |
| **L11** | Le verdict sur F-14 (`document.write` vers le CDN) et sur `scripts/update.sh` — si F-14 est corrigé, HW-AG-01 change de critère ; une session « mise à jour en place + rollback » serait à ajouter | HW-AG-01, nouvelle session |
| **L02** | Le verdict sur le moteur de règles lumière : **la session 8 n'a de sens qu'après** | Session 8, prérequis |

**Rien d'autre n'a été perdu faute de timing** : les seuils, commandes et
constantes cités proviennent tous d'une lecture directe du code à
`8dc170e`, pas d'un rapport tiers.
