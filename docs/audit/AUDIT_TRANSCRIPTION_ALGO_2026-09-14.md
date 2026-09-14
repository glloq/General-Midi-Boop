# Audit — Qualité MIDI, Raspberry Pi et intégration GMB (2026-09-14)

Second audit du module `src/transcription/`, portant sur les modifications
apportées depuis le premier (entrée par glisser-déposer, libellé conditionnel)
et sur trois questions de fond : **est-ce fonctionnel**, **est-ce tenable sur un
Raspberry Pi**, et surtout **le MIDI produit est-il bon pour le reste de GMB**.

**Méthode.** Aucun jugement à l'œil. Des signaux synthétiques dont les notes
sont connues exactement (hauteur, début, durée, nuance, vibrato, glissando)
passent par le vrai moteur, puis le résultat est relu comme GMB le relit, et
soumis à l'analyse de canal et à l'auto-assignation réelles de GMB. Les chiffres
ci-dessous sont mesurés sur cette machine ; un Pi 4 est environ 5 à 8× plus lent.

**Statut :** 5 défauts corrigés, 1 limite du moteur documentée et signalée à
l'utilisateur, 1 point ouvert assumé. Suites : **236 suites / 3 510 tests**
backend, **94 fichiers / 1 712 tests** frontend, 0 erreur ESLint, Prettier et
`tsc` propres, ratchet de schémas vert.

---

## 1. Ce que le MIDI vaut, mesuré

| Signal source | Attendu | Obtenu |
| --- | --- | --- |
| Gamme de 8 notes | `60 62 64 65 67 69 71 72` | **identique**, attaques à ±10 ms, durées à ±10 ms |
| Accord tenu (do-mi-sol) | 3 notes, polyphonie 3 | 3 notes + 1 artefact de 70 ms, **polyphonie 3** |
| Nuance forte/faible | 2 notes | 2 notes + 1 artefact, vélocités 89 / 103 |
| Structure | — | Format 1, 480 PPQ, piste 0 = conducteur, **aucun chevauchement de même hauteur** |

Rien à redire sur la hauteur ni sur le placement. Les artefacts de 70 ms en fin
de note tenue existent et survivent au filtre de durée de `balanced` (30 ms) ;
le preset `clean` les supprime.

## 2. ✅ Chaque note était un tiers de demi-ton trop haute

Le défaut le plus important de cet audit, et invisible sans mesure.

Sur des sons **parfaitement justes** — sinus pur, puis 4 et 8 harmoniques — le
moteur rapporte **+1 bin sur chaque note**, une bin valant 1/3 de demi-ton
(33 cents), soit la plus petite déviation qu'il sache exprimer :

| Désaccord réel | Rapporté |
| --- | --- |
| 0 cent | **+33 cents** |
| +40 cents | +67 cents |
| −40 cents | 0 cent |

L'export MIDI **de Basic Pitch lui-même** donne les mêmes valeurs (`1365` ticks
= 33 cents) : notre conversion est exacte, le biais est celui du moteur. Fidèle,
mais faux pour GMB : tout instrument qui honore le pitch bend joue la
transcription 33 cents trop haut, en permanence.

**Correctif.** Une zone morte à la résolution exacte du moteur
(`ENGINE_PITCH_BIN_SEMITONES`). Une courbe qui ne sort jamais de la zone morte
ne dit rien et est supprimée ; une courbe qui a une vraie excursion garde
**tous** ses points, y compris les petits — percer des trous dans un vibrato là
où il repasse au centre serait pire que de ne rien faire. `raw` reste fidèle,
biais compris.

| Signal | `raw` | `balanced` |
| --- | --- | --- |
| Note parfaitement stable | 65 bends, 0..33 cents | **0 bend** |
| Vibrato ±50 cents | 65 bends | 59 bends, 0..67 cents |
| Vibrato ±100 cents | 176 bends | 83 bends, −133..200 cents |
| Glissando +150 cents | 130 bends | 16 bends, 0..100 cents |

Deux effets secondaires appréciables : le fichier produit **diminue de moitié**,
et l'encodage synchrone d'un morceau de dix minutes passe de 167 ms à 31 ms.

## 3. ⚠️ Le moteur ne ré-attaque pas une note répétée

Six sol de 300 ms séparés par un silence reviennent en **un seul flux continu**
de fragments de même hauteur, tant que le silence n'atteint pas ~180 ms :

| Silence entre les notes | Notes du moteur | `balanced` | `clean` | Vérité |
| --- | --- | --- | --- | --- |
| 50 ms | 11 (écarts de 0 ms) | 11 | 1 | 6 |
| 80 ms | 11 | 11 | **6** | 6 |
| 120 ms | 12 | 12 | **6** | 6 |
| 180 ms | 6 | **6** | **6** | 6 |

Aucun réglage de qualité n'y change rien (`fast`, `balanced`, `maximum` donnent
9, 11 et 12 fragments). Ce n'est pas le post-traitement qui perd le rythme : le
moteur ne l'a jamais rapporté.

Cela compte plus ici que dans un séquenceur : **un Note On est un marteau, un
solénoïde ou un changement d'archet** à l'autre bout de GMB. Onze frappes pour
six notes, ou pour une seule note tenue.

Rien en aval ne peut reconstituer un rythme que le moteur n'a pas vu, donc le
correctif **ne touche pas aux notes** : il compte la plus longue série de
fragments contigus et le dit sur l'écran de résultat, en indiquant le preset qui
les reconstruit (`clean`, dès 80 ms). Vérifié sur l'API réelle : l'avertissement
arrive bien jusqu'au client.

## 4. ✅ Trois défauts d'intégration et de plateforme

- **Un OOM signalait « exit code null ».** La détection ne lisait que le texte
  de `stderr`, or le tueur OOM du noyau envoie SIGKILL à un processus qui
  n'écrit rien — précisément la panne que ce code disait viser sur un Pi. Un
  signal à cet endroit ne peut venir que de l'extérieur : l'annulation et le
  timeout rejettent plus tôt.
- **Le plancher de RAM annoncé était faux.** `minimumRamMb: 1024` alors que le
  moteur culmine à **725 Mo mesurés** sur 30 s d'audio. Avec Raspberry Pi OS et
  GMB, un Pi 3B+ (1 Go) est tué, pas ralenti. Annonce corrigée à 2048.
- **Le bouton « Actualiser » des Réglages ne faisait rien.** `_runProbe`
  appelait `backend.checkAvailability()` sans argument, donc un moteur qui met
  son propre résultat en cache — celui livré le fait, la vérification lance
  Python — répondait la même chose indéfiniment. La procédure documentée
  (« créez le venv à la main, puis Actualiser ») ne pouvait pas fonctionner, et
  un environnement cassé en cours de route restait « Prêt ».

## 5. Adéquation avec le reste de GMB

Vérifié sur le serveur réel, la vraie base et l'API réelle.

- `analyze_channel` relit la transcription sans difficulté : ambitus 72–79,
  distribution des hauteurs, polyphonie max 1 / moy 1, `usesPitchBend: false`,
  `usedCCs: []`, densité 2,1.
- `generate_assignment_suggestions` route le fichier vers **DIY Flute**
  (score 69), en disant : « No program in MIDI channel », « Perfect note range
  fit (no transposition) », « Sufficient polyphony (1 available, 1 needed) »,
  « No CCs used by channel », `issues: []`, transposition 0.

Le choix de **ne pas inventer de programme GM** quand le moteur ignore
l'instrument (§15) s'avère être exactement ce que l'assignateur veut : il le
signale comme une information, puis apparie sur l'ambitus et la polyphonie
plutôt que sur une famille fausse.

**Aucune collision de CC.** L'encodeur n'émet que du CC 11 (Expression) et le
RPN standard (CC 100/101/6/38), tous hors des plages CC14-31 / 85-90 / 102-119
que `docs/MIDI_CC_INSTRUMENT_CONTROLS.md` réserve aux contrôles d'instrument.
GMB ne traite pas le RPN lui-même — il le transmet, ce qui est le comportement
correct : c'est l'instrument qui doit régler sa plage.

## 6. ⛔ Point ouvert assumé — la boucle d'événements

Le post-traitement et l'encodage sont **synchrones**. Mesuré à la limite de
durée configurée par défaut (10 minutes) :

| Cas | Ici | Estimation Pi 4 |
| --- | --- | --- |
| 5 000 notes, 9 sur 10 stables (réaliste) | 112 ms | **~0,5 s** |
| 5 000 notes, toutes avec vibrato (pire cas) | 272 ms | **~1,2 s** |

Pendant ce temps l'ordonnanceur MIDI ne tourne pas. Si une lecture est en cours
quand une transcription se termine, elle accroche une fois. GMB considère
lui-même qu'un blocage de 50 à 200 ms perturbe l'ordonnanceur
(`src/api/WsOutputQueue.js`).

**Non corrigé, et après mesure des alternatives, à ne pas corriger ainsi.**

Les trois façons de ne pas bloquer, chiffrées sur les mêmes 5 000 notes
(coût payé sur le thread principal) :

| Option | Coût sur le thread principal |
| --- | --- |
| Ne rien faire (aujourd'hui) | **166 ms** |
| Fil d'exécution, en postant le résultat | **463 ms** de `structuredClone` seul |
| Fil d'exécution, en postant un chemin | **175 ms** rien que pour démarrer le fil |

Un worker coûte donc **plus cher que le travail lui-même** : le démarrage seul
dépasse le calcul qu'il est censé déporter, et poster l'objet triple la facture.
Le démarrer à l'avance, pendant que le moteur tourne, ne fait que déplacer le
blocage du début à la fin du travail ; le maintenir chaud en permanence coûte de
la RAM résidente sur un Pi pour une fonctionnalité occasionnelle — précisément
le compromis que l'ADR-005 refuse pour le démon Python.

Reste le découpage asynchrone de `process()` et `encode()`. C'est la seule
option qui réduise réellement le blocage, mais ce qu'elle achète est étroit :
**elle ne change quelque chose que si GMB joue au moment précis où une
transcription se termine.** Le prix est de rendre asynchrones deux
transformations pures, avec des points d'attente dans des boucles chaudes et une
cinquantaine d'appels de test à reprendre.

Le blocage est borné, unique, en fin d'un travail que l'utilisateur a lancé
lui-même, et la zone morte du §2 l'a déjà réduit de moitié. **Recommandation :
laisser en l'état**, et n'y revenir que si quelqu'un signale un accroc réel.

## 7. Fonctionnel — vérifié dans un navigateur réel

- Un fichier audio déposé sur la zone **ou n'importe où sur la page** ouvre la
  modale, fichier déjà choisi (nom, taille, durée).
- Un `.mid` déposé va toujours à la bibliothèque et n'ouvre rien ; un `.txt`
  n'ouvre rien.
- Sans moteur : l'étiquette et le `accept` du sélecteur ne parlent que de MIDI.
  Avec moteur : ils annoncent l'audio. Le basculement est **immédiat** quand un
  moteur apparaît, sans rechargement, et un changement de langue conserve la
  bonne variante.
- Les options que le moteur ne sait pas honorer sont grisées avec leur raison.
- Une conversion lancée depuis le dépôt va jusqu'à son écran de résultat.
- Aucune erreur console.
