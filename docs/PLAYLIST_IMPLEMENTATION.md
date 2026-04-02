# Playlists et gestion des fichiers non-routés

## Architecture

### Backend

| Fichier | Rôle |
|---------|------|
| `src/storage/Database.js` | 6 méthodes playlist_items (get, add, remove, reorder, clear, updateLoop) |
| `src/api/commands/PlaylistCommands.js` | 14 commandes WebSocket (CRUD + start/next/prev/stop/status) |
| `src/midi/MidiPlayer.js` | Queue system (setQueue, playQueueItem, nextInQueue, previousInQueue, _handleFileEnd), disconnect policy, broadcastStatus avec info queue |
| `src/midi/PlaybackScheduler.js` | Callback onFileEnd, playback_channel_skipped event, disconnect policy branching (skip/pause/mute), CC filtering dans split routing |
| `src/api/commands/PlaybackCommands.js` | playback_validate_routing + playback_set_disconnect_policy |

### Frontend

| Fichier | Rôle |
|---------|------|
| `public/js/views/components/PlaylistPage.js` | Page modale fixe 900x600px (2 colonnes: playlists + items), rename, loop toggle, drag-and-drop reorder, routing status dots |
| `public/js/views/components/PlaylistEditorModal.js` | Modal d'ajout de fichiers (2 colonnes: fichiers dispo avec filtre "Routed only" + playlist items), routing status dots |
| `public/styles/playlist.css` | Styles PlaylistPage (scopés sous .playlist-view-container) |
| `public/styles/modal-playlist.css` | Styles PlaylistEditorModal |
| `public/index.html` | Bouton header cercle 🎶, bouton fichier 📋, batch action, boutons prev/next dans header-playback, WebSocket handlers |
| `public/locales/en.json`, `fr.json` | Traductions i18n (section "playlist") |

### Base de données

Tables `playlists` (id, name, description, loop, created_at, updated_at) et `playlist_items` (id, playlist_id, midi_id, position) — migration 007.

## Parcours utilisateur

### Accès
- Bouton cercle `🎶` dans le header (entre instruments 🎸 et lighting 💡)
- Ouvre PlaylistPage en modal fixe 900x600px

### Gestion des playlists
- Créer : bouton "+" dans la sidebar gauche → prompt nom
- Renommer : bouton ✏️ dans le header central (recrée la playlist avec le nouveau nom)
- Supprimer : bouton 🗑️ sur chaque playlist dans la sidebar
- Boucle : bouton 🔁 toggle dans le header central (opacité visuelle)

### Ajout de fichiers
- Depuis PlaylistPage : bouton "+ Add files" → PlaylistEditorModal
  - 2 colonnes : fichiers disponibles (avec recherche + filtre "Routed only") | contenu playlist
  - Pastilles vertes/rouges indiquant le statut de routing
  - Compteur de fichiers routés
- Depuis la liste principale : bouton 📋 par fichier → dropdown des playlists
- Action batch : sélection multiple + bouton "📋 Ajouter à playlist"

### Lecture
- Bouton "▶ Play" dans PlaylistPage (désactivé si playlist vide)
- Contrôles dans header-playback existant :
  - ⏮ Previous / ⏭ Next (affichés uniquement pendant lecture playlist)
  - ▶️/⏸️ Play/Pause fonctionne pour les playlists
  - ⏹️ Stop arrête la playlist et vide la queue
  - Info playlist "3/12" à côté du nom de fichier
- Transitions automatiques entre fichiers (stop-load-start avec rechargement des routings)

## Gestion des instruments non-routés

### Validation pré-lecture
Commande `playback_validate_routing` : vérifie chaque canal actif pour routing + device en ligne.

### Feedback pendant la lecture
- `playback_channel_skipped` : émis une fois par canal non-routé
- `playback_device_error` / `playback_device_disconnected` : émis une fois par device

### Politique de déconnexion
Commande `playback_set_disconnect_policy` :

| Mode | Comportement |
|------|-------------|
| `skip` (défaut) | Continue, ignore les events |
| `pause` | Pause la lecture |
| `mute` | Auto-mute les canaux affectés |

## Commandes WebSocket

### Playlists
- `playlist_create`, `playlist_delete`, `playlist_list`, `playlist_get`
- `playlist_add_file`, `playlist_remove_file`, `playlist_reorder`, `playlist_clear`
- `playlist_set_loop`
- `playlist_start`, `playlist_next`, `playlist_previous`, `playlist_stop`, `playlist_status`

### Validation/Policy
- `playback_validate_routing`
- `playback_set_disconnect_policy`

### Events WebSocket émis
- `playlist_item_changed` : `{ playlistId, index, totalItems, fileId, filename }`
- `playlist_ended` : `{ playlistId }`
- `playback_status` : inclut `playlistId, queueIndex, queueTotal, queueLoop, queueFile` si playlist active
- `playback_channel_skipped` : `{ channel, channelDisplay, reason }`
- `playback_device_error` : `{ deviceId, channel, message }`
- `playback_device_disconnected` : `{ deviceId, channel, policy, mutedChannels?, message }`
