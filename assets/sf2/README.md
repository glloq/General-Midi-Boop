# Built-in default soundfont

This directory holds the soundfont that powers the in-browser MIDI synth out of
the box. It is what `bank id = "sf2:default"` resolves to (see
`src/files/SF2PresetService.js`). Once it is on disk, the project no longer
makes any network call to a third-party CDN to play sound.

The file `default.sf2` is **not committed** because it is too large to track
comfortably in Git. It is fetched once by the postinstall script
`scripts/install-default-sf2.js`, which runs automatically after
`npm install` and is idempotent (no re-download if the file already exists
and matches the expected SHA-256).

If the file is missing at runtime, the synth keeps booting but every preset
request to `/api/sf2/default/preset/...` returns 404 — the UI surfaces a toast
asking the user to run `npm run install-default-sf2` (or restart `npm install`).

## Default soundfont

- **Name:** GeneralUser GS
- **Author:** S. Christian Collins
- **Upstream:** <https://schristiancollins.com/generaluser.php>
- **Direct download (mirror used by the install script):**
  <https://github.com/musescore/MuseScore/raw/master/share/sound/MuseScore_General.sf3>
  is **not** used because it is SF3 (Ogg-compressed); we mirror the plain SF2.
  The script defaults to the upstream MuseScore mirror that publishes
  GeneralUser GS as `.sf2`. See the script for the exact URL list.
- **Size:** ~30 MB
- **License:** GeneralUser GS License (custom, very permissive). Quoting the
  upstream:

  > GeneralUser GS is free to use anywhere with no restrictions other than the
  > requirement that it not be redistributed in a modified form without
  > permission, and that the credits remain intact.

  In other words, the project may redistribute the unmodified file with
  attribution. The full license text shipped by upstream is `GeneralUser GS
  License v2.0.txt`; the install script downloads and stores it next to
  `default.sf2` for proof-of-attribution.

## Adding more local banks

End users can drop additional `.sf2` files into the running app via the
Settings → Sound → SF2 panel; uploads land in `data/sf2/` (DB-tracked, see
`CustomSF2DB`). The `assets/sf2/` directory is only for the project-shipped
default.
