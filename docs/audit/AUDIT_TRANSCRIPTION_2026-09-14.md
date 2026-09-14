# Audit — Transcription audio → MIDI (2026-09-14)

Audit final du module `src/transcription/` livré par les PR 1 à 15. Objectif :
vérifier que la fonctionnalité est **réellement** intégrée au projet et qu'elle
ne peut pas casser GMB.

**Méthode.** Les tests unitaires du module simulent la frontière de processus :
ils prouvent que GMB pilote correctement FFmpeg, pip et le moteur, et ne peuvent
rien dire de ce que ces programmes répondent vraiment. Cet audit a donc été mené
**en exécutant le produit** : `better-sqlite3` a été recompilé pour démarrer le
vrai serveur, FFmpeg et Python sont installés, le moteur Basic Pitch a été
installé par l'installeur du produit, et l'interface a été pilotée dans un
Chromium réel.

Les cinq défauts trouvés l'ont **tous** été de cette façon. Aucun n'était
visible depuis la suite de tests, qui était verte avant comme après.

**Statut :** 5 défauts corrigés (tous avec tests de non-régression), 1 défaut
**préexistant** signalé et non corrigé (hors périmètre), 1 PR volontairement non
livrée (licence non vérifiable). Suites : **236 suites / 3 483 tests** backend,
**94 fichiers / 1 692 tests** frontend, 0 erreur ESLint, Prettier propre,
`tsc --noEmit` propre, ratchet de schémas vert.

---

## ✅ Défauts trouvés et corrigés

### 1. L'installation de Basic Pitch ne pouvait jamais réussir — *bloquant*

`requirements.txt` épinglait `tensorflow==2.15.1` et `resampy==0.4.3` alors que
`basic-pitch 0.4.0` exige `tensorflow<2.15.1` et `resampy<0.4.3` : les deux pins
étaient posés **sur** la borne exclusive au lieu d'en dessous. pip répondait
`ResolutionImpossible` avant de télécharger quoi que ce soit — pour tous les
utilisateurs, sur toutes les plateformes.

Pire pour la cible principale : la branche aarch64 installait
`tensorflow-aarch64`, qui est un paquet PyPI **sans rapport, figé en version
1.2** — pas le build ARM de TensorFlow. Le paquet `tensorflow` publie des roues
`manylinux_2_17_aarch64`, donc la séparation par marqueur était à la fois fausse
et inutile. Un seul pin sert maintenant le Pi et le reste.

*Vérifié :* installation réelle en 71 s, statut `installable → available`.

### 2. L'installeur était privé de son réseau — *bloquant derrière un proxy*

La liste blanche d'environnement de `ProcessRunner` est juste pour tout ce qui
tourne pendant une transcription — FFmpeg lit un fichier local, le moteur exécute
un modèle local, ni l'un ni l'autre n'a à joindre le réseau. Mais installer un
moteur est la seule opération qui le doit. Privé de `HTTPS_PROXY`,
`REQUESTS_CA_BUNDLE`, `PIP_CERT` et consorts, pip échouait sur une erreur TLS ou
DNS **alors que le même pip depuis le shell de l'opérateur fonctionnait**, sans
rien dans le message pour expliquer la différence.

`networkEnv()` accorde ces variables à l'appel pip **et à lui seul** : le défaut
reste strict et l'octroi est un unique site d'appel greppable. Une URL de proxy
embarque couramment `user:password`, ce qui est précisément la raison pour
laquelle elles ne rejoignent pas la liste partagée.

### 3. Aucun contrôle de version de l'interpréteur — *message inexploitable*

L'installeur acceptait n'importe quel Python répondant à `--version`. TensorFlow
2.15 ne publie de roues que pour CPython 3.9 à 3.11 : sur plus récent, GMB
créait un venv, téléchargeait plusieurs minutes, puis rapportait « no matching
distribution », ce qui se lit comme une panne réseau. La version est maintenant
vérifiée **avant** la création de l'environnement et le refus nomme
l'interpréteur trouvé et la plage attendue.

### 4. L'interface n'entendait rien de ce que le serveur disait — *bloquant*

Trouvé en pilotant la vraie interface. Le job s'exécutait, le MIDI arrivait dans
la bibliothèque, et la modale restait sur « Préparation de l'audio » **pour
toujours**. Trois fautes distinctes :

- **Rien n'était diffusé.** GMB n'a pas de pont générique EventBus → WebSocket :
  un service qui veut que l'interface sache le dit lui-même, comme le fait
  `FileManager` pour `file_list_updated`. Le gestionnaire de jobs, l'installeur
  et le registre n'émettaient que sur le bus. Une écoute de la socket pendant un
  job complet ne voyait que deux trames : `connected` et `file_list_updated`.
- **Le gestionnaire de jobs n'aurait de toute façon pas pu diffuser.** Il était
  construit avec un littéral `{ logger, eventBus, settings }` au lieu de la
  façade `deps`, donc `_deps.wsServer` valait `undefined` pour toujours —
  `wsServer` s'enregistre plus bas dans `initialize()`, ce qui est exactement
  la raison de la règle du projet. Il reçoit désormais la façade comme ses
  voisins et résout sa propre configuration depuis `deps.config`.
- **Le commentaire du registre promettait ce pont** (« PR 6 bridges this bus
  event to a WebSocket broadcast ») et la PR 6 ne l'a jamais construit. C'est
  fait, et le panneau Réglages y réagit.

*Vérifié :* la socket porte maintenant `created → preprocessing → transcribing
(10 %, 85 %) → postprocessing → generating_midi → importing → complete`, et la
modale affiche la progression puis le résultat.

### 5. Deux fautes côté interface

- **Chemin absolu exposé au client (§40).** Le champ `detail` est rendu tel quel
  dans la modale ; pour un moteur absent il portait le chemin d'installation
  absolu du serveur — le nom du compte et l'arborescence de l'hôte, remis à
  n'importe quel client. Il nomme désormais le chemin **relatif** à
  l'installation, celui-là même qu'impriment les docs ; l'absolu part dans le
  log, là où est l'opérateur.
- **Options non honorables proposées (§15).** En mode `auto` — le défaut, donc
  ce que voit presque tout le monde — les cinq options étaient offertes quel que
  soit le moteur. Cocher « Détecter la batterie » pour un moteur qui n'en trouve
  aucune produisait un résultat silencieusement vide. `auto` filtre maintenant
  sur ce que les moteurs **installés** savent faire : avec un seul moteur c'est
  simplement sa réponse, avec plusieurs l'option survit si l'un d'eux peut être
  choisi.

---

## ⚠️ Défaut préexistant signalé, non corrigé

**`POST /api/files` répond une page HTML sur un corps trop gros.** body-parser
lève depuis l'intérieur du middleware, donc le `try/catch` du handler ne le voit
jamais et Express répond sa page d'erreur par défaut. Un client qui parse du JSON
reçoit `Unexpected token '<'`. Mesuré côte à côte :

| Route | Corps trop gros |
| --- | --- |
| `POST /api/files` | `413 text/html` — `<!DOCTYPE html>…PayloadTooLargeError` |
| `POST /api/transcription` | `413 application/json` — `{"reason":"FILE_TOO_LARGE",…}` |

C'est la route d'upload MIDI du projet, antérieure à ce travail. Le correctif est
le même wrapper que celui écrit pour `/api/transcription` (5 lignes), mais
changer le contrat d'erreur d'une route utilisée par toute l'application n'est
pas une décision à prendre au détour d'un audit : **signalé, laissé en l'état.**

---

## 🚫 Volontairement non livré

**PR 12 — moteur multi-instruments.** Le cahier des charges (§8) interdit
d'intégrer un moteur dont la licence exacte n'a pas été vérifiée, et demande
explicitement de traiter MuScriptor avec prudence : ne pas le télécharger
silencieusement, ne pas l'inclure dans la distribution, afficher sa licence avant
installation. Aucune vérification de licence n'ayant pu être faite, **aucun
moteur multi-instruments n'est fourni**. L'architecture l'accueille sans
modification : un moteur est une classe dans `backends/`, auto-découverte, et le
vocabulaire de statut contient déjà `license_restricted`.

---

## Ce qui a été vérifié en exécution

| Vérification | Résultat |
| --- | --- |
| Démarrage sans Python, sans moteur | propre ; capacité `disabled`, aucune autre touchée |
| Démarrage **sans FFmpeg** (PATH assaini) | propre ; capacité `degraded`, message actionnable |
| Transcription sans FFmpeg | `FFMPEG_MISSING` — « install FFmpeg to convert audio files » |
| Installation réelle du moteur | 71 s, `available`, version `0.4.0` remontée |
| Transcription réelle bout en bout | arpège C4-E4-G4-C5 → notes MIDI **60, 64, 67, 72** |
| Fichier dans la bibliothèque | `midi_files` id=1, 2 pistes, GM programme 0, ambitus 60–72 |
| Presets | `balanced` → 4 pitch bends ; `maximum`/`clean` → 16 |
| Annulation | moteurs 0 → 1 → **0**, job `cancelled`, aucun zombie |
| Script shell nommé `.wav` | `UNSUPPORTED_FORMAT` (signature refusée) |
| En-tête RIFF sans média | `UNSUPPORTED_FORMAT` (refusé par ffprobe, pas deviné) |
| `../../../../etc/passwd.wav` | importé comme `passwd [Transcribed].mid`, dossier `/` |
| Nom commençant par `-` | traité comme argument, jamais comme option |
| Audio de 20 min (plafond 10) | `AUDIO_TOO_LONG` — « Audio is 20:00; the limit is 10:00 » |
| Corps de 120 Mo | `413 application/json` |
| Répertoires de travail après tout ça | **0** |
| Bouton d'en-tête | absent par défaut, révélé par Réglages, ouvre la modale |
| i18n | 28 locales × 66 clés, aucune manquante, aucune vide, aucune non traduite |
| `shell: true` / `exec` / `eval` dans le domaine | aucun ; un seul site de `spawn` |

## Ce qui n'a pas pu être vérifié ici

- **Les chiffres sur un vrai Raspberry Pi.** Le conteneur est un x86 généreux.
  `scripts/transcription-benchmark.mjs` existe pour mesurer sur la machine
  réelle, stage par stage ; les valeurs du tableau de `docs/AUDIO_TRANSCRIPTION.md`
  restent des estimations tant qu'un Pi ne les a pas produites.
- **Les moteurs autres que Basic Pitch**, puisqu'il n'y en a pas (voir PR 12).
