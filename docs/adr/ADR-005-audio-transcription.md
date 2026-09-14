# ADR-005 — Transcription audio → MIDI : moteurs interchangeables en sous-processus

- **Statut** : Accepté
- **Date** : 2026-09-14
- **Supersedes** : —
- **Références** :
  [`ADR-001`](./ADR-001-refactor-strategy.md),
  [`ADR-004`](./ADR-004-declarative-command-schemas.md),
  [`docs/AUDIO_TRANSCRIPTION.md`](../AUDIO_TRANSCRIPTION.md),
  [`src/transcription/`](../../src/transcription/)

## Contexte

GMB sait jouer un fichier MIDI sur un orchestre d'instruments physiques. Il ne
sait rien faire d'un enregistrement audio. Or la demande la plus fréquente est
exactement celle-là : « j'ai un morceau, je n'ai pas la partition ».

Transcrire de l'audio en MIDI demande aujourd'hui un modèle appris. Ces modèles
sont écrits en Python, reposent sur TensorFlow ou PyTorch, pèsent des centaines
de mégaoctets, et leurs licences vont de l'Apache 2.0 au « recherche
uniquement ». Aucun n'est intégrable tel quel dans un projet Node.js destiné à
tourner **hors ligne sur un Raspberry Pi**.

Quatre contraintes cadrent donc la décision :

1. **Rien ne doit régresser.** Une installation sans Python, sans FFmpeg et
   sans moteur doit démarrer et fonctionner exactement comme avant.
2. **Le Pi est la cible.** 1 à 8 Go de RAM, une carte SD, pas de GPU. Une
   transcription ne doit jamais faire tomber la lecture MIDI en cours.
3. **Hors ligne.** Aucun appel réseau au runtime, aucun service tiers.
4. **Les licences sont un problème produit, pas un détail.** Certains modèles
   interdisent l'usage commercial ; un projet ne peut pas les embarquer ni les
   télécharger à l'insu de l'utilisateur.

## Options considérées

### Option A — Une bibliothèque JS de transcription, en process

Faire tourner un modèle dans Node (ONNX Runtime, TensorFlow.js).

- **+** Pas de Python, pas de sous-processus, une seule pile.
- **−** Les modèles de transcription publiés ne le sont pas dans ces formats ;
  il faudrait les convertir et les maintenir convertis.
- **−** Un plantage ou une fuite mémoire du modèle **tue le serveur**, donc la
  lecture en cours et les instruments connectés.
- **−** Impossible de borner la mémoire d'une inférence in-process.

Rejetée : le coût de conversion est récurrent, et le partage du process avec le
temps réel MIDI est rédhibitoire.

### Option B — Un service Python permanent à côté du serveur

Un démon Python (FastAPI / gRPC) lancé au boot, interrogé par Node.

- **+** Le modèle reste chargé : deuxième transcription plus rapide.
- **−** Un démon qui tient TensorFlow en mémoire **en permanence** sur un Pi,
  pour une fonctionnalité utilisée quelques minutes par semaine.
- **−** Deux cycles de vie à superviser, deux logs, deux façons de tomber.
- **−** Un port ouvert de plus, à authentifier ou à isoler.

Rejetée : le coût permanent est payé par tous les utilisateurs, y compris ceux
qui n'activeront jamais la fonctionnalité.

### Option C — Sous-processus à la demande, moteurs interchangeables (retenue)

Un moteur est un programme externe lancé pour un job, qui écrit son résultat sur
`stdout` en JSON Lines versionné, puis se termine.

- **+** La mémoire du modèle est rendue au système à la fin du job.
- **+** Un plantage du moteur est un code de sortie, pas un serveur mort.
- **+** L'annulation est un signal au groupe de processus, pas un espoir.
- **+** Le langage du moteur devient un détail d'implémentation : le prochain
  moteur peut être un binaire Rust sans rien changer en amont.
- **−** Coût de démarrage payé à chaque job (import de TensorFlow : ~10 s).
- **−** Un protocole à définir et à versionner.

Retenue. Le coût de démarrage est négligeable devant la durée d'une
transcription, et il est payé **uniquement** par ceux qui l'utilisent.

## Décision

1. **Un domaine `src/transcription/`**, branché sur la racine de composition
   existante (`Application.initialize()` → `ServiceContainer`), sans singleton
   global et dans le respect de l'ordre d'enregistrement.
2. **Un contrat de moteur abstrait** (`TranscriptionBackend`) : métadonnées,
   capacités déclarées, licence, disponibilité, `transcribe()`, installation
   facultative. Un registre auto-découvre les implémentations de
   `backends/`.
3. **Communication Node ↔ moteur par sous-processus** : `spawn` avec argv
   séparé (jamais `shell: true`), environnement filtré, groupe de processus
   dédié, JSON Lines versionné sur `stdout`, diagnostics sur `stderr`.
4. **Python isolé dans un venv** créé par GMB sous son répertoire de données.
   Le Python système n'est jamais modifié. Aucune dépendance Python n'entre
   dans `package.json`.
5. **Une représentation intermédiaire riche** (`TranscriptionResult`) qui
   conserve la confiance par note et les courbes d'expression, **avant** toute
   conversion en MIDI. Le MIDI est une projection de ce résultat, pas
   l'inverse.
6. **`FileManager.handleUpload()` est la frontière finale.** Le module produit
   un buffer `.mid` et le remet à la bibliothèque existante. Il n'écrit pas
   dans la bibliothèque, ne crée pas de seconde bibliothèque, ne duplique
   aucune logique d'import.
7. **Consentement explicite avant tout téléchargement de modèle.** Un moteur
   dont la licence l'exige ne s'installe pas sans une acceptation qui **nomme
   la licence affichée** ; si elle a changé depuis, l'installation est
   refusée.
8. **Absent proprement, et sans bouton.** Le service est instancié par défaut
   parce qu'il ne coûte rien tant qu'aucun moteur n'est installé (une sonde au
   démarrage, aucun modèle, aucun réseau) ; `transcription.enabled` à `false`
   le fait disparaître entièrement. Il n'y a **pas** de bouton dédié : un
   fichier audio déposé sur l'interface — ou choisi dans le navigateur de
   fichiers — ouvre la conversion. Un bouton masqué par défaut aurait rendu la
   fonctionnalité indécouvrable ; la zone de dépôt existait déjà et savait
   déjà refuser ce fichier.

## Ce que le contrat de moteur impose

Un moteur **déclare** ses capacités (polyphonie, multi-instruments, batterie,
pitch bend, dynamique, progression) et le pipeline ne demande que ce qui est
déclaré. Un moteur monophonique ne se voit jamais reprocher de ne pas séparer
les instruments, et l'interface ne propose pas l'option.

Un moteur **ne devine pas**. Ce qu'il ignore (l'instrument, le tempo) reste
`null` jusqu'à la couche de mapping, qui applique une règle explicite et
modifiable (`gm/InstrumentClassMap.js`, `gm/DrumMapper.js`). Aucune précision
n'est inventée en chemin.

Un moteur **a un statut**, pas un booléen : `available`, `not_installed`,
`installable`, `license_restricted`, `unsupported_platform`, `broken`. « Ne
marche pas » et « n'est pas installé » ne se présentent pas de la même façon à
l'utilisateur.

## Impacts

### Ce qu'on gagne

- Une fonctionnalité lourde qui ne coûte **rien** à qui ne l'utilise pas :
  ni RAM, ni disque, ni surface d'attaque, ni dépendance.
- Le remplacement d'un moteur est une classe à écrire, pas une refonte.
- Tout ce qui suit le MIDI produit (éditeur, auto-assignation, adaptation,
  lecture) fonctionne sans une ligne de code supplémentaire, puisque le
  fichier entre par la porte habituelle.
- L'annulation et les limites (durée, taille, disque, timeout) sont
  vérifiables, parce qu'elles sont dans le superviseur Node et pas dans le
  moteur.

### Ce qu'on sacrifie

- ~10 s de démarrage par job (import du runtime Python).
- Le modèle est rechargé à chaque job : pas de cache chaud entre deux
  transcriptions.
- Un protocole maison à versionner (`RUNNER_PROTOCOL_VERSION`), au lieu d'un
  appel de fonction.
- La qualité dépend d'un moteur externe que le projet ne contrôle pas.

## Règles dures

- Ne jamais construire une commande shell par concaténation ; `spawn` avec argv
  séparé uniquement.
- Ne jamais installer de paquet Python dans le Python système.
- Ne jamais télécharger un modèle sans afficher sa licence et obtenir une
  action explicite.
- Ne jamais intégrer un moteur dont la licence exacte n'a pas été vérifiée
  (c'est la raison pour laquelle aucun moteur multi-instruments n'est fourni à
  ce jour).
- Ne jamais bloquer la boucle d'événements ni la lecture MIDI pendant une
  transcription.
- Un fichier téléversé est hostile : extension, signature, taille, durée,
  répertoire de travail isolé, chemins vérifiés, timeout.

## Plan de rollback

La fonctionnalité est déjà désactivée par défaut : `transcription.enabled` à
`false` suffit à la faire disparaître entièrement (aucun service instancié,
aucune commande exposée, aucun bouton). Un retrait complet est un `git revert`
du domaine `src/transcription/`, de son module de commandes et de son schéma —
aucune migration de base de données n'a été créée, aucun contrat WebSocket
existant n'a été modifié.

## Critères de réussite

- Un démarrage sans Python, sans FFmpeg et sans moteur est identique à un
  démarrage d'avant la fonctionnalité (suites `tests/audit/*offline-first*`).
- Un fichier audio produit un `.mid` valide dans la bibliothèque, ouvrable
  dans l'éditeur.
- Une annulation ne laisse aucun processus ni aucun répertoire temporaire.
- Ajouter un moteur ne demande de toucher ni au service, ni au gestionnaire de
  jobs, ni à l'interface.
