# Etude d'implémentation : Playlists et gestion des instruments non-routés

## Contexte

Ma-est-tro (MidiMind 5.0) est un système d'orchestration MIDI full-stack (Node.js/Express + Vanilla JS frontend). Le système gère des fichiers MIDI, les route vers des instruments physiques connectés (USB, Bluetooth, Network, Serial) et joue les fichiers avec compensation de latence.

**Problème actuel :**
1. **Playlists partiellement implémentées** : La table DB `playlists` + `playlist_items` existe (migration 007), le CSS est complet (870+ lignes), mais le backend n'a que du CRUD basique et aucun composant frontend JS n'existe. MidiPlayer ne gère qu'un seul fichier à la fois.
2. **Instruments déconnectés/non-routés** : Les canaux sans routing sont silencieusement ignorés (log warning seulement). Les devices déconnectés en cours de lecture génèrent un seul event WebSocket `playback_device_error`, mais aucune option de récupération n'est offerte à l'utilisateur.

---

## Partie 1 : Système de Playlists

### 1A. Couche Base de Données — `src/storage/Database.js`

**Pas de nouvelle migration nécessaire** — `playlist_items` existe déjà (migration 007) avec le bon schéma.

Ajouter 6 méthodes après les méthodes playlist existantes (~ligne 514) :

| Méthode | SQL |
|---------|-----|
| `getPlaylistItems(playlistId)` | `SELECT pi.*, mf.filename, mf.duration, mf.tempo FROM playlist_items pi JOIN midi_files mf ON pi.midi_id = mf.id WHERE pi.playlist_id = ? ORDER BY pi.position` |
| `addPlaylistItem(playlistId, midiId, position?)` | INSERT avec position = MAX(position)+1 si non spécifié |
| `removePlaylistItem(itemId)` | DELETE + recompact positions restantes |
| `reorderPlaylistItem(playlistId, itemId, newPosition)` | Transaction : shift + update position |
| `clearPlaylistItems(playlistId)` | `DELETE FROM playlist_items WHERE playlist_id = ?` |
| `updatePlaylistLoop(playlistId, loop)` | `UPDATE playlists SET loop = ?, updated_at = ? WHERE id = ?` |

Réutiliser le pattern `better-sqlite3` transaction déjà utilisé dans Database.js.

### 1B. Commandes Backend — `src/api/commands/PlaylistCommands.js`

Compléter le fichier existant (actuellement 31 lignes) avec :

- `playlist_get` — Détails playlist + items (appelle `getPlaylist` + `getPlaylistItems`)
- `playlist_add_file` — Compléter le stub existant ligne 21-24
- `playlist_remove_file` — Appelle `removePlaylistItem(data.itemId)`
- `playlist_reorder` — Appelle `reorderPlaylistItem()`
- `playlist_set_loop` — Appelle `updatePlaylistLoop()`
- **`playlist_start`** — Charge la playlist, configure la queue dans MidiPlayer, démarre le premier fichier
- `playlist_next` / `playlist_previous` — Avancer/reculer dans la queue
- `playlist_status` — État courant de la playlist active

**Design clé :** `playlist_start` configure la queue puis délègue à la logique `playbackStart` existante pour éviter de dupliquer le chargement des fichiers et des routings.

### 1C. Queue dans MidiPlayer — `src/midi/MidiPlayer.js`

Ajouter au constructeur (après ligne 31) :

```javascript
this.queue = [];          // [{ fileId, midiId, filename }]
this.queueIndex = -1;     // Position courante (-1 = pas de queue)
this.queueLoop = false;   // Boucler toute la queue
this.playlistId = null;   // ID playlist active
```

Nouvelles méthodes :
- `setQueue(items, loop, playlistId)` — Configure la queue
- `clearQueue()` — Reset
- `getQueueStatus()` — État courant
- `playQueueItem(index)` — Charge fichier, charge routings DB, démarre lecture
- `nextInQueue()` / `previousInQueue()` — Navigation

**Modification critique — gestion de fin de fichier :**

Dans `_schedulerTick()` (ligne 450-463), ajouter un callback `onFileEnd` :

```javascript
onFileEnd: () => this._handleFileEnd()
```

`_handleFileEnd()` :
1. Si `this.loop` → seek(0) (comportement existant inchangé)
2. Sinon si `this.queue.length > 0` → `this.nextInQueue()`
3. Sinon → `this.stop()`

Dans `PlaybackScheduler.tick()`, remplacer l'appel direct à `onStop`/`onSeek` en fin de fichier par `onFileEnd`.

**Transition entre fichiers :** stop-load-start (pas de lecture gapless — acceptable pour un outil d'orchestration MIDI). Les routings sont rechargés depuis la DB pour chaque fichier (le pattern existe déjà dans `PlaybackCommands.js` lignes 26-43).

**Nouveaux événements WebSocket :**
- `playlist_item_changed` — `{ playlistId, index, fileId, filename }`
- `playlist_ended` — Queue terminée sans boucle

### 1D. Frontend PlaylistView — `public/js/views/components/PlaylistView.js` (nouveau)

Le CSS complet existe déjà dans `public/styles/playlist.css`. Le composant doit générer du HTML correspondant aux classes CSS définies.

Layout 3 colonnes (défini dans le CSS) :
- **Sidebar gauche** (`.playlist-sidebar.left`) : Liste des playlists
- **Centre** (`.playlist-main`) : Navigateur de fichiers MIDI disponibles
- **Sidebar droite** (`.playlist-sidebar.right`) : Panel de queue/items de la playlist sélectionnée

Suit les patterns existants : `extends BaseView`, utilise `AppRegistry.getInstance()`, `EventBus` pour les events.

Drag-and-drop HTML5 pour réordonner les items (le CSS `.drag-handle` est déjà défini).

---

## Partie 2 : Gestion des instruments non-routés/déconnectés

### 2A. Validation pré-lecture — `src/api/commands/PlaybackCommands.js`

Nouvelle commande `playback_validate_routing` :

```javascript
async function playbackValidateRouting(app, data) {
    // 1. Charger le fichier MIDI, extraire les canaux actifs
    // 2. Pour chaque canal, vérifier si un routing existe en DB
    // 3. Pour chaque device routé, vérifier s'il est connecté via deviceManager
    return {
        channels: [
            { channel: 0, status: 'routed', deviceId: '...', deviceOnline: true },
            { channel: 1, status: 'unrouted' },
            { channel: 9, status: 'routed', deviceId: '...', deviceOnline: false },
        ],
        allRouted: false,
        allOnline: false,
        warnings: ['Channel 2 has no routing', 'Device X is disconnected']
    };
}
```

Pour les playlists, ajouter `playlist_validate_routing` qui itère sur tous les items et retourne un rapport consolidé.

### 2B. Feedback amélioré dans PlaybackScheduler — `src/midi/PlaybackScheduler.js`

**Canaux non-routés** (ligne 168-171) : Actuellement log warning seulement. Ajouter notification WebSocket throttlée :

```javascript
// Ajouter _unroutedChannels Set (similaire à _failedDevices)
if (!routing) {
    if (!this._unroutedChannels.has(event.channel)) {
        this._unroutedChannels.add(event.channel);
        this.app.wsServer?.broadcast('playback_channel_skipped', {
            channel: event.channel,
            channelDisplay: event.channel + 1,
            reason: 'no_routing'
        });
    }
    return;
}
```

Reset `_unroutedChannels` dans `resetForPlayback()`.

### 2C. Politique de déconnexion configurable — `src/midi/MidiPlayer.js` + `PlaybackScheduler.js`

Ajouter `disconnectedPolicy` à MidiPlayer (3 modes) :

| Politique | Comportement | Cas d'usage |
|-----------|-------------|-------------|
| `'skip'` (défaut) | Continue la lecture, ignore les events pour ce device | Performance live, on veut que ça continue |
| `'pause'` | Pause la lecture, affiche modal pour reconnecter | Répétition, on veut tout entendre |
| `'mute'` | Mute automatiquement les canaux affectés, continue | Compromis : continue mais signale le problème |

Modifier `sendEvent()` dans PlaybackScheduler (lignes 303-314) pour brancher sur la politique.

Nouvelle commande : `playback_set_disconnect_policy` dans PlaybackCommands.js.

### 2D. Indicateurs visuels Frontend

Intégrer dans le flux existant (pas de nouvelle vue) :

1. **Avant lecture** : Appeler `playback_validate_routing` → si problèmes, afficher modal avec options "Jouer quand même", "Ouvrir l'éditeur de routing", "Annuler"
2. **Pendant lecture** : Écouter les events WebSocket :
   - `playback_channel_skipped` → Toast/notification
   - `playback_device_disconnected` → Modal selon la politique
   - `playback_device_error` → Indicateur persistant
3. **Dans la liste des canaux** : Pastilles de statut :
   - Vert = routé + device en ligne
   - Jaune = routé + device hors ligne
   - Rouge = pas de routing

---

## Séquençage d'implémentation

### Phase 1 — Backend Playlist (testable via WebSocket)
1. `Database.js` : Ajouter 6 méthodes playlist_items
2. `PlaylistCommands.js` : Compléter toutes les commandes CRUD + playback
3. `MidiPlayer.js` : Ajouter état queue + méthodes de gestion
4. `PlaybackScheduler.js` : Modifier gestion fin-de-fichier (callback `onFileEnd`)

### Phase 2 — Validation Routing (indépendant des playlists)
5. `PlaybackCommands.js` : Commande `playback_validate_routing`
6. `PlaybackScheduler.js` : Feedback canaux non-routés
7. `PlaybackScheduler.js` + `MidiPlayer.js` : Politique de déconnexion
8. `PlaybackCommands.js` : Commande `playback_set_disconnect_policy`

### Phase 3 — Frontend
9. `PlaylistView.js` : Nouveau composant (utilisant le CSS existant)
10. Intégrer validation pré-lecture dans le flux de playback
11. Handlers WebSocket pour les warnings runtime

### Phase 4 — Intégration
12. `playlist_validate_routing` : Validation pour tous les items d'une playlist
13. UX transitions routing entre items de playlist

---

## Décisions architecturales clés

1. **Queue dans MidiPlayer**, pas dans une nouvelle classe — MidiPlayer possède déjà le cycle de vie de lecture
2. **Transition stop-load-start** entre fichiers (pas de gapless) — acceptable pour MIDI orchestration
3. **Routing par fichier, rechargé à chaque transition** — réutilise le pattern existant de `playbackStart`
4. **Politique de déconnexion au niveau player**, pas par device — plus simple à implémenter et comprendre
5. **Pas de nouvelle migration** — `playlist_items` existe déjà avec le bon schéma

## Fichiers critiques à modifier

| Fichier | Changements |
|---------|-------------|
| `src/storage/Database.js` (~ligne 514) | +6 méthodes playlist_items |
| `src/midi/MidiPlayer.js` | +queue state, +5 méthodes queue, +disconnectedPolicy, modifier fin-de-fichier |
| `src/api/commands/PlaylistCommands.js` | Compléter avec ~8 nouvelles commandes |
| `src/midi/PlaybackScheduler.js` | +_unroutedChannels, +disconnect policy branching, +onFileEnd callback |
| `src/api/commands/PlaybackCommands.js` | +playback_validate_routing, +playback_set_disconnect_policy |
| `public/js/views/components/PlaylistView.js` (nouveau) | Composant frontend playlist |

## Vérification

1. **Backend playlists** : Via WebSocket, envoyer `playlist_create`, `playlist_add_file`, `playlist_start` et vérifier que les fichiers se jouent séquentiellement
2. **Fin de queue** : Vérifier que `playlist_ended` est émis quand la queue se termine sans boucle
3. **Loop** : Vérifier que la queue recommence si `loop=true`
4. **Validation routing** : Appeler `playback_validate_routing` avec un fichier ayant des canaux non-routés, vérifier le rapport
5. **Politique déconnexion** : Tester `pause` en déconnectant un device USB pendant la lecture
6. **Frontend** : Ouvrir la vue playlist, créer une playlist, ajouter des fichiers, lancer la lecture, vérifier les transitions
