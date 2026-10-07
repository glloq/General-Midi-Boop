# Audit — capacités MIDI réelles des instruments GMB

**Date :** 2026-10-07  
**Objectif :** déterminer ce que chaque firmware consomme réellement, puis aligner GMB Host sur ces capacités.  
**Méthode :** code d'exécution / contrôleurs / descripteurs en priorité ; README utilisé seulement comme contexte. La présence d'un type dans un enum ou dans un parseur n'est pas considérée comme un support fonctionnel.

## Règle de lecture

- **Oui** : le message provoque un effet musical, mécanique, de routage ou de sécurité réel.
- **Non** : explicitement ignoré / no-op dans le contrôleur.
- **Dynamique** : dépend de la configuration active ; le descripteur doit refléter l'état courant.
- **Inconnu** : aucune preuve suffisante ; GMB doit rester permissif.

Les statuts matériels (testé sur machine réelle ou non) sont séparés du support logiciel.

## Matrice synthétique

| Projet | Note On/Off | CC réellement utilisés | Pitch Bend | Channel AT | Poly AT | Program Change | Realtime | GMB v2 / descriptor |
|---|---|---|---|---|---|---|---|---|
| Servo-Flute-GMB | Oui | 1, 2, 7, 11, 73, 74 selon config + channel-mode safety | Non | Non | Non | Non trouvé | Non déclaré | **Oui, dynamique** |
| Drums-Engine-GMB | Oui | CC issus du routage compilé, dont hi-hat selon config | Dynamique si pipeline actif | Non | Non | Non trouvé | Non déclaré | **Oui, dynamique** |
| PlayMode-GMB | Oui | CC configurés par mode/actionneur | Non dans le dispatcher | Non dans le dispatcher | Non dans le dispatcher | Non dans le dispatcher | Non déclaré | **Oui** |
| Servo-Plucked-Strings-GMB | Oui | 7, 11, sustain configurable, 120, 123, sélecteurs corde/frette | Non trouvé | Non trouvé | Non trouvé | Non trouvé | Non déclaré | GMB/SysEx présent, à harmoniser au bloc `messages` |
| Stepper-Plucked-Strings-GMB | Oui | 7, 11, sustain configurable, 120, 123, sélecteurs corde/frette | Non trouvé | Non trouvé | Non trouvé | Non trouvé | Non déclaré | GMB/SysEx présent, à harmoniser au bloc `messages` |
| Servo-bowed-strings-GMB | Oui | 7, 11, sustain configurable, 120, 123, sélecteurs corde/frette | Non trouvé | Non trouvé | Non trouvé | Non trouvé | Non déclaré | GMB/SysEx présent, à harmoniser au bloc `messages` |
| stepper-bowed-string-GMB | Oui | 1, 7, 11, sustain configurable, 120, 123, sélecteurs corde/frette | Non trouvé | **Oui** | Non trouvé | Non trouvé | Non déclaré | GMB/SysEx présent, à harmoniser au bloc `messages` |
| slide_Whistle-GMB | Oui | expression/volume/breath/vibrato/sustain/angle selon config | **Dynamique**, plage déclarée | **Dynamique** | Non | Non trouvé | Non déclaré | **Oui, dynamique** |
| servo-Melodica-GMB | Oui | 7, 11, 64, 120, 121, 123 | **Non / no-op** | **Non / no-op** | **Non / no-op** | **Non / no-op** | Stop + System Reset ont un effet sécurité ; Clock/Start/Continue no-op | Pas de v2 complet trouvé dans le code audité |
| Orchestrion_trumpet | Oui | 1, 2, 7, 11, 64, RPN0 PB sensitivity, 120, 121, 123 | **Oui**, plage configurable | **Oui** | Non trouvé | **Optionnel** (voicings) | System Reset sécurité ; autres realtime sans effet moteur direct | Migration GMB v2 à faire |
| Accordion-servo-midi | Oui | 7, 11, 64, 120, 123 | Non | Non | Non | Non | Non | Legacy / migration GMB v2 à faire |
| harmonica_Midi | Oui | breath, expression, modulation/vibrato, all-notes-off | **Oui**, modèle ±2 demi-tons | Parsé mais non transmis au moteur | Parsé mais non transmis | Parsé mais non transmis | Realtime ignoré | Migration GMB v2 à faire |

## Détails par dépôt

### Servo-Flute-GMB

Sources principales : `docs/GMB_PROTOCOL.md` et firmware actif.

- Descripteur GMB v2 construit depuis la configuration validée en cours.
- Notes monophoniques ; table de doigtés pouvant déclarer une plage ou un ensemble discret.
- Vélocité annoncée uniquement si `airVelocityResponse` produit réellement un effet.
- CC dynamiques :
  - CC1 modulation si vibrato actif ;
  - CC2 breath si activé ;
  - CC7 volume / plafond de débit ;
  - CC11 expression ;
  - CC73 attaque ;
  - CC74 uniquement lorsque le système de jet-angle de flûte traversière est actif.
- Pitch Bend, Channel Aftertouch et Poly Aftertouch explicitement non supportés dans le protocole audité.
- CC de mode canal 120/121/123-127 traités séparément comme sécurité/contrôle.
- Préparation mécanique, réarticulation, demi-trous, angle de jet, multiples sources d'air et calibration micro optionnelle.
- BLE/RTP peuvent faire la découverte GMB lorsqu'un chemin retour existe. Un DIN uniquement RX peut jouer mais pas répondre au handshake.

### Drums-Engine-GMB

Source principale : `docs/gmb-protocol.md` + routage compilé.

- Le descripteur est dérivé du routage **compilé réellement actif**.
- Liste de notes exacte, CC exacts et polyphonie par canal logique.
- Vélocité réelle.
- Hi-hat CC, notes associées, choke/mute groups et contraintes actionneur exposables dynamiquement.
- Pitch Bend seulement si le pipeline/actionneur actif le rend réellement utile.
- Timing de préparation pour moteurs/stepper lorsque nécessaire.

### PlayMode-GMB

Sources : `play-mode/midi_types.h`, `play-mode/midi_dispatcher.cpp`, `play-mode/gmb_capabilities.cpp`.

Point important : `midi_types.h` sait représenter Note, CC, Program Change, Channel Pressure, Poly Aftertouch et Pitch Bend, mais `midi_dispatcher.cpp` n'exécute que :

- Note On ;
- Note Off ;
- Control Change.

Les autres types doivent donc être déclarés `false`, pas `true`.

Options : modes servo/solénoïde, mappings CC configurables, courbes de vélocité, budgets puissance/ressource, latence actionneur, calibration acoustique optionnelle, panic/sécurité.

### Servo-Plucked-Strings-GMB

Source : `firmware/src/core/instrument/InstrumentController.cpp`.

- Note On/Off.
- Vélocité → intensité de pincement.
- CC7 + CC11 → gain d'attaque.
- Sustain via CC configurable lorsqu'activé.
- CC120 et CC123.
- Paire de CC de sélection corde/frette pour pré-positionner la mécanique.
- Allocation accords, fallback des cordes en défaut.
- Aucun effet Pitch Bend / aftertouch / Program Change trouvé dans le contrôleur audité.

### Stepper-Plucked-Strings-GMB

Source : `firmware/src/core/instrument/InstrumentController.cpp`.

Même famille sémantique que Servo-Plucked, avec déplacement stepper :

- Note On/Off ;
- CC7/11 ;
- sustain configurable ;
- CC120/123 ;
- sélecteurs corde/frette ;
- vélocité ;
- préparation, homing, transposition/capo, sécurité et allocation d'accords.

Aucun traitement Pitch Bend / aftertouch / Program Change trouvé dans le contrôleur.

### Servo-bowed-strings-GMB

Source : `firmware/src/core/instrument/InstrumentController.cpp`.

- Note On/Off.
- CC7/11 modifient réellement les notes déjà tenues.
- sustain configurable, CC120/123, sélecteurs corde/frette.
- vélocité + préparation/allocation/fallback de chaîne en défaut.
- Aucun Pitch Bend / aftertouch / Program Change trouvé dans le contrôleur audité.

### stepper-bowed-string-GMB

Source : `firmware/src/core/instrument/InstrumentController.cpp`.

- Note On/Off.
- CC7/11 : expression continue.
- CC1 : modulation/crescendo de l'archet.
- **Channel Aftertouch** : pression continue réellement appliquée au calcul de dynamique.
- sustain configurable, CC120/123, sélecteurs corde/frette.
- `continuousDynamics` contrôle si CC/aftertouch actualisent immédiatement les notes tenues.
- Aucun Pitch Bend / Program Change trouvé dans le contrôleur.

### slide_Whistle-GMB

Sources : `esp32/esp32_slide_whistle/MIDIHandler.h`, `esp32/GMB_PROTOCOL.md`.

- Note On/Off.
- Pitch Bend avec plage déclarée, généralement ±2 demi-tons par défaut.
- Channel Aftertouch si la configuration active l'utilise.
- CC1 et autres CC d'air/expression/vibrato/sustain/angle selon la mécanique active.
- Vélocité uniquement si elle modifie effectivement le débit/air.
- Poly Aftertouch non supporté.
- Capacité réellement dynamique : ne pas créer de profil fixe par nom de projet.

### servo-Melodica-GMB

Sources : `ServoMelodica/MidiEvent.h`, `ServoMelodica/InstrumentController.cpp`.

Le type interne peut représenter presque tout MIDI 1.0, mais le contrôleur musical exécute seulement :

- Note On/Off ;
- CC7 volume ;
- CC11 expression ;
- CC64 sustain ;
- CC120 All Sound Off ;
- CC121 Reset Controllers ;
- CC123 All Notes Off ;
- Stop → all notes off ;
- System Reset → panic.

Pitch Bend, Program Change, Channel Pressure et Poly Pressure sont explicitement sans effet. Clock/Start/Continue sont acceptés mais sans effet musical. Vélocité agit sur l'air.

### Orchestrion_trumpet

Source : `docs/MIDI.md` + architecture firmware.

- Note On/Off.
- CC1 modulation/vibrato, CC2 breath, CC7 volume, CC11 expression, CC64 sustain.
- Pitch Bend configurable ±1/±2/±3/±12 demi-tons ; défaut ±2.
- Channel Pressure : source de vibrato + modulation brightness/volume.
- RPN 0 via CC101/100/6 pour Pitch Bend Sensitivity.
- Program Change sélectionne un voicing sauvegardé **seulement si l'option est activée**.
- CC120/121/123.
- System Reset a un effet sécurité ; MPE non implémenté.
- USB (S3), BLE, RTP, DIN et Web selon plateforme/configuration.

### Accordion-servo-midi

Source : `accordionV06/midiHandler.cpp`.

- Note On/Off.
- CC7 volume, CC11 expression, CC64 sustain, CC120, CC123.
- Les autres messages de canal sont ignorés.
- Pas de preuve de Pitch Bend, aftertouch, Program Change ou SysEx applicatif.
- 59 servos, stepper de soufflet, homing optique, polyphonie mécanique limitée ; matériel encore à qualifier.

### harmonica_Midi

Sources : `include/midi/MidiParser.h`, `include/midi/MidiRouter.h`, `include/engine/NoteEngine.h`.

- Note On/Off.
- Breath, expression, modulation/vibrato et all-notes-off.
- Pitch Bend transmis au moteur, modèle ±2 demi-tons.
- vélocité → intensité si `velocityToIntensity` est actif.
- Program Change / Channel Pressure / Poly Aftertouch sont consommés par le parseur pour préserver le flux mais ne sont pas transmis au moteur.
- Realtime ignoré sans casser le running status.
- Modes blow/draw, arbitrage de direction, polyphonie configurable, slide/vibrato et systèmes d'air optionnels.

## Conséquences pour GMB Host

L'ancien host ne persistait que plage de notes, notes discrètes, polyphonie et CC du descripteur. Pourtant le v2 avait déjà des champs pour vélocité, Pitch Bend et aftertouch.

La mise à jour 2026-10-07 introduit :

1. un modèle sémantique `messages` extensible ;
2. une normalisation rétrocompatible des anciens descripteurs v2 ;
3. une persistance JSON tri-state dans `instruments_latency.midi_message_support` ;
4. le miroir automatique de Pitch Bend vers `pitch_bend_enabled` ;
5. une politique runtime sûre : **seul `false` explicite autorise le host à filtrer** ; inconnu reste permissif.

Le host ne contient volontairement **aucune table codée en dur par nom de projet**. Les projets GMB natifs doivent publier leurs capacités actives ; les firmwares legacy restent configurables/manuels jusqu'à migration.

## Dépôts legacy / historiques

Les anciens projets Arduino et expérimentaux (`ukuletron`, anciens orchestrions piano/xylophone/organ, anciens contrôleurs plucked strings, etc.) ne deviennent pas des profils statiques du host. Leur comportement reste `unknown` tant qu'ils n'émettent pas de descripteur GMB v2 ou qu'un utilisateur ne configure pas explicitement leurs capacités. Cette décision évite de figer dans GMB Host des hypothèses liées à une version historique du firmware.

Le dépôt privé `midi-hand-pinao` n'est pas détaillé dans ce document public ; le nouveau contrat générique permet néanmoins au host de consommer ses capacités lorsqu'un firmware GMB v2 les déclare à l'exécution.
