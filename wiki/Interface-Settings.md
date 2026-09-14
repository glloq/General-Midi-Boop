# Interface — Settings

The settings modal stores user preferences that apply across the entire Général Midi Boop interface. All values are persisted in `localStorage` under the key `gmboop_settings` and restored automatically on each page load.

Source: [`public/js/features/SettingsModal.js`](https://github.com/glloq/General-Midi-Boop/blob/main/public/js/features/SettingsModal.js).

## Appearance

### Theme

| Value | Description |
|-------|-------------|
| **Light** | White background, dark text — ideal for well-lit environments |
| **Dark** | Dark background — reduces eye strain in stage / low-light conditions |
| **Coloured** | Accent-coloured variant of the dark theme |

The theme is applied immediately on selection via CSS custom properties; no reload is required.

## Language

28 UI languages are supported:

English · French · Spanish · German · Italian · Portuguese · Dutch · Polish · Russian · Chinese · Japanese · Korean · Turkish · Hindi · Bengali · Thai · Vietnamese · Czech · Danish · Finnish · Greek · Hungarian · Indonesian · Norwegian · Swedish · Ukrainian · Esperanto · Tagalog

GM instrument names are localised in every language. Note names follow the selected locale's convention:

| Convention | Example |
|------------|---------|
| **US / English** | C4, D#4, A4 |
| **Solfège (FR/IT/…)** | Do4, Ré#4, La4 |
| **MIDI number** | 60, 63, 69 |

The note-name format affects the [[Interface-Microphone|tuner]], the [[MIDI-Editor]], and the [[Interface-Virtual-Piano|virtual keyboard]] labels.

## Virtual Keyboard

| Setting | Range | Description |
|---------|-------|-------------|
| **Octave count** | 1–4 | Number of octaves shown by default when the virtual keyboard opens |

## Interaction Preferences

| Setting | Description |
|---------|-------------|
| **Touch mode** | Optimise tap targets and disable hover effects for touch-screen devices |
| **Keyboard feedback** | Highlight keys on the virtual keyboard as computer keyboard keys are pressed |
| **Drag feedback** | Show ghost element during drag-and-drop operations in the playlist and editor |

## Audio → MIDI Engines

Lists every transcription engine GMB knows about and what each one can do, with its licence and its status: *Ready*, *Can be installed*, *Installed but unusable*, or *Not supported on this platform*.

**Install** creates the engine's own isolated Python environment and installs its pinned dependencies, then re-runs the engine's self-check before claiming success — "Ready" means it really starts, not that an installer exited cleanly. A failed install is rolled back so the next attempt starts from a clean state. **Refresh** re-checks an engine for real, which is what you want after creating an environment by hand.

An engine whose licence requires it shows that licence and will not install until you accept it. Nothing is downloaded before that.

See [[Interface-Audio-To-Midi]] for what the engines are for and what to expect from them.

## Persistence

Settings are stored in:

```
localStorage["gmboop_settings"] = {
  "theme": "dark",
  "language": "fr",
  "keyboardOctaves": 2,
  "touchMode": false,
  "keyboardFeedback": true,
  "dragFeedback": true
}
```

Clearing localStorage (browser developer tools → Application → Local Storage) resets all preferences to defaults.

## Related Pages

- [[Interface-Virtual-Piano]] — the keyboard octave count and keyboard feedback settings apply here
- [[Interface-Microphone]] — note-name locale affects tuner display
- [[Advanced-Topics]] — adding a new language (copy en.json, translate, register)
- [[Interface-Audio-To-Midi]] — the transcription engines installed from this page
