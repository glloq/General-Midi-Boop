# Built-in default soundfont

This directory holds the soundfont that powers the in-browser MIDI synth out of
the box. It is what `bank id = "sf2:default"` resolves to (see
`src/files/SF2PresetService.js`). Once it is on disk, the project no longer
makes any network call to a third-party CDN to play sound.

The file `default.sf2` is **not committed** because it is too large to track
comfortably in Git. It is fetched once by the postinstall script
`scripts/install-default-sf2.js`, which runs automatically after `npm install`
and is idempotent.

### Integrity

> **Read this before trusting the file.** An earlier version of this README
> claimed the install script skipped the re-download when the file "matches the
> expected SHA-256". **It did not: there was no expected SHA-256 anywhere in the
> project, and the only checks were a 1 MB size floor and the `RIFF`/`sfbk`
> magic bytes** — enough to catch an HTML error page, and nothing else. A mirror
> serving a different but well-formed soundfont passed. Audit 2026-09-07, F-109
> / F-15.

The mechanism now exists, and here is exactly what it does today:

| | |
|---|---|
| SHA-256 verification of `default.sf2` | **Implemented**, and enforced both after a download and on the idempotency check (`alreadyPresent()`), so an already-tampered file cannot survive unnoticed. |
| A pinned reference digest shipped with the project | **Not yet.** `PINNED_SHA256.sf2` in the install script is `null`. |
| What that means in practice | The script prints `integrity NOT verified` on every run, out loud, and installs the file. |

Pinning is deliberately left to a human: the digest must come from a download
whose provenance was checked by hand, not from whatever a mirror happened to
serve during a build. To pin it:

1. Obtain `GeneralUser GS v1.471` from upstream through a channel you trust.
2. `sha256sum assets/sf2/default.sf2`
3. Paste the digest into `PINNED_SHA256.sf2` in
   `scripts/install-default-sf2.js`, in a commit that records where the bytes
   came from.

Per-run override: `GMBOOP_SF2_SHA256=<digest>`. Hardened builds can set
`GMBOOP_REQUIRE_PINNED_ASSETS=1` to refuse any artefact that has no pin.

Once a digest is pinned, a mismatch **deletes the file and fails the install
with a non-zero exit** — never a silent warning. An unreachable mirror still
exits 0, because that is a network problem, not a supply-chain one.

The same applies to `public/lib/WebAudioFontPlayer.js`, which the same script
downloads and which the SPA *executes* on every page load
(`PINNED_SHA256.player`, `GMBOOP_WAF_PLAYER_SHA256`).

> **Pick the player's version before pinning its digest.** Upstream relicensed
> `webaudiofont` from MIT to GPL-3.0-or-later at 2.5.49, so pinning whatever
> `latest` serves today would freeze a GPL-3 file inside an MIT-announced
> product *and* make the question look answered. `GMBOOP_WAF_PLAYER_VERSION`
> pins the version; the choice itself is a maintainer decision — see
> `docs/audit/2026-09-07/WAVE2_R10.md` §3.5.

If the file is missing at runtime, the synth keeps booting but every preset
request to `/api/sf2/default/preset/...` returns 404 — the UI surfaces a toast
asking the user to run `npm run install-default-sf2` (or restart `npm install`).

## Default soundfont

- **Name:** GeneralUser GS
- **Author:** S. Christian Collins
- **Upstream:** <https://schristiancollins.com/generaluser.php>
- **Mirrors used by the install script:** two `raw.githubusercontent.com`
  mirrors of the official 1.471 release, then the upstream author's `.zip`.
  The exact, ordered list is `SF2_MIRRORS` in
  `scripts/install-default-sf2.js`; `GMBOOP_SF2_URL` overrides it.
  MuseScore's `MuseScore_General.sf3` is **not** used: it is SF3
  (Ogg-compressed), and we need the plain SF2.
- **Size:** ~30 MB
- **License:** GeneralUser GS License (custom, very permissive). Quoting the
  upstream:

  > GeneralUser GS is free to use anywhere with no restrictions other than the
  > requirement that it not be redistributed in a modified form without
  > permission, and that the credits remain intact.

  In other words, the project may redistribute the unmodified file with
  attribution. The full license text shipped by upstream is `GeneralUser GS
  License v2.0.txt`. **The install script does not fetch it** — an earlier
  version of this README said it did. Attribution therefore rests on this
  README until someone adds the file; see audit finding F-158.

## Adding more local banks

End users can drop additional `.sf2` files into the running app via the
Settings → Sound → SF2 panel; uploads land in `data/sf2/` (DB-tracked, see
`CustomSF2DB`). The `assets/sf2/` directory is only for the project-shipped
default.
