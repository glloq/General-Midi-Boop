# MidiEditorModal — cartographie des mixins (P2-F.10)

**Date** : 2026-04-17
**Scope** : clarifier la composition actuelle de `MidiEditorModal`
(pattern mixin) et poser la roadmap vers des modules explicites.

## État actuel

`MidiEditorModal` (~360 LOC) est une classe instanciée avec
`(eventBus, apiClient)`. Son comportement est étendu par un mécanisme
de **mixins au runtime** : 12 objets globaux dont les clés sont
copiées dans `MidiEditorModal.prototype` au chargement de
`MidiEditorModal.js`.

```js
// src/...MidiEditorModal.js (~ligne 342)
const _mixins = [
  MidiEditorSequenceMixin, MidiEditorCCMixin, MidiEditorDrawSettingsMixin,
  MidiEditorCCPickerMixin, MidiEditorFileOpsMixin, MidiEditorRendererMixin,
  MidiEditorRoutingMixin, MidiEditorEditActionsMixin, MidiEditorDialogsMixin,
  MidiEditorEventsMixin, MidiEditorTablatureMixin, MidiEditorLifecycleMixin
];
_mixins.forEach(m => Object.assign(MidiEditorModal.prototype, m));
```

En parallèle, des **sous-composants instanciés** servent des rôles
ciblés :
- `channelPanel = new MidiEditorChannelPanel(this)`
- `ccPanel = new MidiEditorCCPanel(this)` (P2-F.6, constantes extraites)
- `toolbar = new MidiEditorToolbar(this)`
- `_playback = new MidiEditorPlayback(this)` (façade clairement
  documentée en L253 via une série de délégations explicites)

## Inventaire des mixins

| Mixin global | Fichier | Responsabilité | LOC indicatif | Candidature à composant dédié |
|---|---|---|---|---|
| `MidiEditorSequenceMixin` | `MidiEditorSequence.js` | Chargement séquence + activeChannels | moyen | 🟡 raisonnable (séparer state séquence vs rendu) |
| `MidiEditorCCMixin` | `MidiEditorCC.js` | Extraction CC/pitchbend, modes | moyen | 🟡 déjà couplé à CCPanel instancié |
| `MidiEditorDrawSettingsMixin` | `MidiEditorDrawSettings.js` | Popover « Draw Settings » | faible | 🟢 UI helper, pas critique |
| `MidiEditorCCPickerMixin` | `MidiEditorCCPicker.js` | Modal de choix CC | faible | 🟢 idem |
| `MidiEditorFileOpsMixin` | `MidiEditorFileOpsMixin.js` | save / save-as / rename / convert / auto-assign | élevé | 🔴 **priorité rewire** — point d'entrée des appels API |
| `MidiEditorRendererMixin` | `MidiEditorRenderer.js` | Rendu pianoroll (webaudio-pianoroll) | élevé | 🔴 priorité, gros volume |
| `MidiEditorRoutingMixin` | `MidiEditorRouting.js` | Routing per-channel, devices | moyen | 🟡 possible cohabitation avec `ChannelPanel` |
| `MidiEditorEditActionsMixin` | `MidiEditorEditActions.js` | Undo/redo/copy/paste/delete | moyen | 🟢 candidat naturel à un service `EditHistoryService` |
| `MidiEditorDialogsMixin` | `MidiEditorDialogs.js` | Dialogs de confirmation | faible | 🟢 helper transverse, possible factor vers `shared/ui` |
| `MidiEditorEventsMixin` | `MidiEditorEvents.js` | Event handlers + resize | moyen | 🔴 couplé à l'orchestrateur ; à simplifier en dernier |
| `MidiEditorTablatureMixin` | `MidiEditorTablature.js` | Tablature (string instruments) | élevé | 🟡 grosse zone, candidat sous-composant |
| `MidiEditorLifecycleMixin` | `MidiEditorLifecycle.js` | open / close / cleanup | faible | 🟢 orchestrateur, à garder dans la classe |

## Constats structurels

1. **Aucune frontière explicite de dépendance** entre mixins : chacun
   suppose la présence des propriétés et méthodes ajoutées par tous
   les autres. Impossible de tester un mixin seul.
2. **Deux patterns cohabitent** : mixins (comportement fusionné dans
   le prototype) et sous-composants (instanciés, reçoivent `modal`).
   Le choix historique n'est pas documenté — il a suivi l'ordre des
   extractions successives.
3. **`MidiEditorPlayback`** est l'exemple réussi : façade explicite
   (lignes 253-271 de `MidiEditorModal.js`) avec une surface minimale.
   À reproduire pour les autres zones.
4. **Shared state non-documenté** : plus de 50 propriétés sur `this`
   sont partagées entre mixins (ex. `this.sequence`, `this.ccEvents`,
   `this.channels`, `this.channelRouting`, `this.isDirty`…).

## Roadmap proposée (à exécuter au fil des lots P2-F suivants)

### Phase A — Convertir les mixins petits en sous-composants simples

Cibles faciles (🟢) :
- `MidiEditorDialogs` → `new MidiEditorDialogs(this)` avec API
  explicite `confirm()`, `alert()`.
- `MidiEditorCCPicker` → sous-composant instancié.
- `MidiEditorDrawSettings` → idem.

Pattern : créer une classe avec constructor `(modal)`, déplacer les
méthodes telles quelles, remplacer dans `MidiEditorModal.js` la fusion
mixin par `this.dialogs = new MidiEditorDialogs(this)`. La surface
reste identique ; le rename des callsites
(`this.confirm()` → `this.dialogs.confirm()`) vient ensuite.

### Phase B — Extraire des services pur-état

- `MidiEditorEditActionsMixin` → `EditHistoryService` (undo/redo
  indépendant du DOM, stockage fonctionnel des diff), réutilisable
  dans le futur.

### Phase C — Renderer + FileOps

Les mixins `Renderer` et `FileOps` méritent un lot chacun — ils
portent l'essentiel du couplage DOM / API. Après les Phases A & B,
ils seront les **dernières zones de complexité**, donc plus lisibles.

### Phase D — Documentation des dépendances partagées

Pour chaque propriété de `this` partagée, désigner un **owner** (le
mixin / sous-composant qui la crée et la modifie). Les autres sont
« lecteurs » → à terme, l'owner expose un getter.

## Non-objectifs de ce lot P2-F.10

- Aucune conversion de mixin → sous-composant **dans ce lot**.
  Risque de régression élevé pour un gain de lisibilité seulement
  partiel. Chaque conversion sera son propre lot P2-F.10x.
- Aucune modification de `MidiEditorModal.js` ni des mixins.

## Lots suivants proposés

- **P2-F.10a** : convertir `MidiEditorDialogsMixin` en sous-composant
  `MidiEditorDialogs` (zone la plus simple, bonne première
  démonstration du pattern).
- **P2-F.10b** : convertir `MidiEditorDrawSettingsMixin`.
- **P2-F.10c** : convertir `MidiEditorCCPickerMixin`.
- **P2-F.10d** : extraire `EditHistoryService` (sortie claire du
  mixin `EditActions`).

Les lots suivants (Renderer, FileOps) attendent la fin des petits
pour bénéficier de la clarté acquise.
