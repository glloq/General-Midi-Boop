# Interface — Playlist & File Library

The playlist page is the MIDI file manager. It handles uploading, organising, searching, and selecting files for playback.

![Playlist page](https://github.com/glloq/General-Midi-Boop/blob/main/docs/images/playlist.png?raw=true)

Source: [`public/js/features/PlaylistPage.js`](https://github.com/glloq/General-Midi-Boop/blob/main/public/js/features/PlaylistPage.js), [`public/js/features/PlaylistEditorModal.js`](https://github.com/glloq/General-Midi-Boop/blob/main/public/js/features/PlaylistEditorModal.js).

## Uploading Files

### Drag-and-Drop

Drag one or more `.mid` / `.midi` files onto the page. They are queued, validated, hashed (SHA-256), and stored. Uploading the same file twice is free — the content-addressable store deduplicates automatically.

### Upload Button

Click **"Upload"** to open a file picker. Multiple files can be selected at once.

### Progress Indicator

A progress bar and file count show the upload queue status. Failures (corrupt files, unrecognised format) are listed with the reason so they can be corrected.

## Folder Organisation

Files live in a virtual folder tree. Operations:

| Operation | How |
|-----------|-----|
| Create folder | Right-click in the file list → **New folder** |
| Move files | Drag-and-drop onto a folder, or multi-select → **Move** |
| Rename folder | Double-click the folder name |
| Delete folder | Right-click → **Delete** (with confirmation if non-empty) |

Folders are stored as metadata; the underlying content-addressed blobs are unchanged.

## File Operations

Right-click any file (or multi-select for batch) to access:

| Action | Description |
|--------|-------------|
| **Play** | Load the file into the transport and start playback |
| **Edit** | Open the [[MIDI-Editor]] with this file |
| **Rename** | Change the display name |
| **Duplicate** | Create a copy in the same folder |
| **Move** | Move to a different folder |
| **Export / Save as** | Download the file to the browser |
| **Delete** | Remove the file (permanent) |

## Search & Filtering

The search bar runs a text search against file names. The **"Filters"** panel exposes advanced criteria:

| Filter | Options |
|--------|---------|
| **Duration** | Min / max length in minutes |
| **Tempo** | BPM range |
| **Track count** | Number of MIDI tracks |
| **Instrument types** | GM families present in the file |
| **Channel count** | Number of active channels |
| **Compatibility** | Minimum compatibility score against connected instruments |

### Filter Presets

Frequently used filter combinations can be saved as named presets and recalled with one click. Presets are stored in localStorage.

## Sorting

Click any column header to sort ascending; click again for descending.

| Column | Description |
|--------|-------------|
| Name | Alphabetical |
| Duration | Length of the file |
| Tempo | BPM (first tempo event) |
| Tracks | Number of MIDI tracks |
| Channels | Number of non-empty channels |
| Compatibility | Score against currently connected instruments |
| Added | Upload timestamp |

## Compatibility Column

The compatibility score (0–100) reflects how well the file can be played by currently connected instruments. It is computed by [[Auto-Assignment]]:

- **Green (80–100)** — file plays well with no adaptation required.
- **Orange (50–79)** — some tracks will be transposed or remapped.
- **Red (0–49)** — significant adaptation or missing instrument types.

Click the score badge to open the auto-assignment detail for that file.

## Playlist Editor Modal

The lightweight **Playlist Editor** modal (`PlaylistEditorModal`) provides a drag-and-drop queue editor for live performance — reorder files to build a set list, remove entries, and advance to the next track without leaving the transport view.

## Related Pages

- [[MIDI-Editor]] — edit a file's notes, CC automation, and tempo after loading it
- [[Auto-Assignment]] — understand and improve the compatibility score
- [[Interface-Main-Page]] — transport controls for loaded files
