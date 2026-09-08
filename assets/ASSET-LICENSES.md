# Asset licences and attributions

Général Midi Boop's own source code is MIT (see [`LICENSE`](../LICENSE)); its npm
dependencies are inventoried in [`THIRD-PARTY-NOTICES.md`](../THIRD-PARTY-NOTICES.md).
**This file covers everything else that is redistributed with the project and is not
project source code**: icons, the default soundfont, vendored browser libraries,
translations and reference data.

> **Rule.** Adding a redistributed non-code file without registering it here fails
> `node scripts/audit/licenses.mjs --assets`.

Nothing below is asserted without evidence. Where provenance could not be established,
the entry says **UNRESOLVED** and states exactly what must be checked — an invented
attribution would be worse than none.

---

## 0. Status at a glance

| Asset group | Files | State |
|---|---|---|
| Default soundfont (`assets/sf2/default.sf2`) | 1 (fetched, not committed) | **PARTIAL** — licence known, licence text not shipped |
| `public/lib/WebAudioFontPlayer.js` (fetched, not committed) | 1 | **CONFLICT** — upstream is **GPL-3.0-or-later**, see §2 |
| WebAudioFont wavetables proxied via `/api/waf/*` | streamed, not stored | **PARTIAL** — see §3 |
| Icons traced to a named upstream set | 7 shipped (+1 copy in `docs/`) | **RESOLVED** — attributions in §4 |
| Icons marked "SVG Repo", collection unknown | 57 shipped | **UNRESOLVED** — see §5 |
| Icons with no third-party marker, presumed in-house | 43 shipped | **TO CONFIRM** — see §6 |
| `docs/images/`, `images-a-faire/` (repo-only) | 58 marked + screenshots | **UNRESOLVED / in-house** — see §7 |
| `public/locales/*.json`, `shared/gm-*.json` | 28 + 2 | OK — see §8 |
| Fonts | none | OK — the UI uses system font stacks only |

**Two entries block a clean redistribution today: §2 (GPL-3.0 code inside an MIT
distribution) and §5 (57 icons of unknown licence).**

---

## 1. Default soundfont — `assets/sf2/default.sf2`

| | |
|---|---|
| Work | GeneralUser GS v1.471 |
| Author | S. Christian Collins |
| Upstream | <https://schristiancollins.com/generaluser.php> |
| How it gets here | `scripts/install-default-sf2.js` at `postinstall`; **not committed** (`.gitignore`) |
| Licence | GeneralUser GS License — custom, permissive: redistribution of the **unmodified** file is allowed, modification requires permission, and **the credits must remain intact** |
| Redistributed in | the Docker image and any Pi install |

**Open item.** The licence text is *not* shipped and *not* downloaded.
`assets/sf2/README.md` claims the install script "downloads and stores it next to
`default.sf2` for proof-of-attribution"; it does not — the script has no such fetch
(that file is being corrected under remediation item R11). Until a copy of
`GeneralUser GS License v2.0.txt` sits next to the soundfont, the "credits remain
intact" condition rests on this document alone.

`assets/sf2/README.md` additionally claims the download is verified against an expected
SHA-256. It is not: `fetchVerified()` checks a minimum byte size and a `RIFF…sfbk`
header, nothing more. Also tracked under R11.

---

## 2. `public/lib/WebAudioFontPlayer.js` — **licence conflict, do not ignore**

| | |
|---|---|
| Work | WebAudioFont — `WebAudioFontPlayer.js` (~124 KB) |
| Author | Sergey Surikov |
| Upstream | <https://github.com/surikov/webaudiofont> · npm `webaudiofont` |
| How it gets here | `scripts/install-default-sf2.js` at `postinstall`, from `surikov.github.io`, jsDelivr or unpkg — **unpinned**, always the current release |
| Redistributed in | `dist/` (`vite.config.js` `copyStaticTree` includes `lib`), the Docker image (`COPY /app/public/lib`), and served to every browser by `public/index.html` |
| Licence | **GPL-3.0-or-later** |

Evidence, current as of 2026-09-08:

```
$ curl -s https://raw.githubusercontent.com/surikov/webaudiofont/master/package.json
  "license": "GPL-3.0-or-later"
$ curl -s https://raw.githubusercontent.com/surikov/webaudiofont/master/npm/dist/WebAudioFontPlayer.js \
    | grep -i gpl
  console.log('WebAudioFont Engine v3.0.04 GPL3');
$ # npm registry, 42 published versions:
$ #   MIT               -> 2.0.1 … 2.5.48   (27 versions)
$ #   GPL-3.0-or-later  -> 2.5.49 … 3.0.4   (15 versions)
```

The package **was MIT and was relicensed to GPL-3.0-or-later at 2.5.49**. Because the
install script pins nothing, an install done before that release vendored MIT code and
an install done today vendors GPL-3.0 code — the licence changed underneath the project
without any change on this side. `scripts/install-default-sf2.js:54-55` still describes
it only as "not redistributable freely without attribution", which understates it by a
wide margin.

A build made today therefore distributes GPL-3.0-or-later code inside a product that
announces itself as MIT. That combination is not resolved by an attribution line. It is
a maintainer decision, and the options are:

1. **Pin `webaudiofont@2.5.48`** (the last MIT release), record the MIT notice here,
   and pin its SHA-256 so the pin cannot drift. `scripts/install-default-sf2.js` already
   exposes both levers (`GMBOOP_WAF_PLAYER_VERSION`, `PINNED_SHA256.player`); pick the
   version **before** filling in the digest, or the pin freezes the GPL-3 build.
2. **Keep the current version and comply with GPL-3.0** for the distributed bundle —
   which constrains how the whole frontend may be distributed.
3. **Replace it** with a permissively licensed SF2/WebAudio player.

Until one is chosen, treat `dist/` and the Docker image as **not cleanly
redistributable under MIT alone**.

---

## 3. WebAudioFont wavetables — proxied at runtime

`src/api/wafProxyRoutes.js` proxies `https://surikov.github.io/webaudiofontdata/sound/`
to the browser via `/api/waf/:filename`. These files are **streamed, never stored or
redistributed** by this project, so no notice ships with the build.

Upstream (`surikov/webaudiofontdata`) declares no licence of its own; its README states
the wavetables are derived from **GeneralUserGS.sf2** and **FluidR3.sf2**, each under
its own terms. If these ever get cached to disk and shipped, this entry stops being
informational and must be resolved first.

---

## 4. Icons traced to a named upstream set — attributions

Seven shipped SVGs were matched **byte-for-byte on their path data** against published
icon sets (method in §9). These attributions are required by the licences named.

### 4.1 CC BY 4.0 — attribution is mandatory

Reusing these files obliges the redistributor to name the author, the source, the
licence, and any modification made. Modifications so far: colour/size normalisation only.

| File | Upstream icon | Set | Author | Licence |
|---|---|---|---|---|
| `public/assets/instruments/violin.svg` | `emojione:violin` | Emoji One (Colored) / Emojitwo | Emoji One — <https://github.com/EmojiTwo/emojitwo> | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| `public/assets/instruments/trumpet.svg` | `emojione:trumpet` | Emoji One (Colored) / Emojitwo | Emoji One — <https://github.com/EmojiTwo/emojitwo> | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| `public/assets/drums/Hand-Clap.svg` | `twemoji:clapping-hands` | Twitter Emoji (Twemoji) | Twitter — <https://github.com/jdecked/twemoji> | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| `public/assets/connection/bluetooth.svg` | `solar:bluetooth-square-*` | Solar | 480 Design — <https://www.figma.com/community/file/1166831539721848736> | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| `docs/images/bluetooth.svg` | same file as above | Solar | 480 Design | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |

> `bluetooth.svg` contains all three paths of `solar:bluetooth-square-broken` verbatim
> plus two more, so it is one of the Solar `bluetooth-square-*` weights; the set and its
> licence are certain, the exact weight is not.

### 4.2 Apache-2.0

Requires the licence text and the copyright notice to travel with the copies.

| File | Upstream icon | Set | Author | Licence |
|---|---|---|---|---|
| `public/assets/instruments/accordion.svg` | `noto:accordion` (`emoji_u1fa97.svg`) | Noto Emoji | Google Inc. — <https://github.com/googlefonts/noto-emoji> | Apache-2.0 |
| `public/assets/instruments/nylon.svg` | `fxemoji:guitar` | Firefox OS Emoji | Mozilla — <https://github.com/mozilla/fxemoji> | Apache-2.0 |
| `public/assets/instruments/bottle.svg` | `icon-park:bottle-one` | IconPark | ByteDance — <https://github.com/bytedance/IconPark> | Apache-2.0 |

Four of these eight files (`trumpet`, `Hand-Clap`, `bottle`, both `bluetooth`) carry the
`<!-- Uploaded to: SVG Repo … -->` marker, i.e. they reached the project through SVG
Repo, which re-hosts other people's sets. Three (`accordion`, `nylon`, `violin`) carry
**no** marker at all — they were previously assumed to be in-house work and are not.
That is the reason §6 below is labelled "to confirm" rather than "MIT".

---

## 5. Icons marked "SVG Repo", source collection unknown — **UNRESOLVED**

**57 shipped SVGs** carry `<!-- Uploaded to: SVG Repo, www.svgrepo.com, Generator: SVG
Repo Mixer Tools -->` and nothing else: no author, no collection, no licence, no
`<title>`/`<desc>`/RDF metadata in 55 of the 57.

```
$ grep -rl svgrepo public/assets/ | wc -l      # 61 marked, 4 of them resolved in §4
$ find public/assets -name '*.svg' | wc -l     # 107 shipped
$ grep -rhoi "licen[^\"<]*" public/assets/     # (empty)
```

SVG Repo does not distribute under a single licence — depending on the collection an
icon may be CC0, MIT, CC BY 4.0 or a more restrictive bespoke licence. **The licence of
these 57 files therefore cannot be stated, and this document will not guess one.** §4
shows the risk is real rather than theoretical: three of the four SVG Repo files that
*could* be traced turned out to be CC BY 4.0, which obliges attribution the project was
not providing.

The files (paths relative to `public/assets/`):

- `instruments/` (43): `acoustic_grand`, `alto_sax`, `bagpipe`, `banjo`, `bassoon`,
  `cello`, `clarinet`, `clean`, `contrabass`, `distortion`, `electric_grand`,
  `electric_piano_1`, `electric_piano_2`, `family_bowed_strings`, `family_brass`,
  `family_chromatic_percussion`, `family_drum_kits`, `family_keyboards`,
  `family_plucked_strings`, `family_reeds`, `family_synths`, `family_winds`,
  `french_horn`, `harmonica`, `harmonics`, `harp`, `marimba`, `muted`, `ocarina`,
  `overdrive`, `pan_flute`, `recorder`, `shakuhachi`, `shamisen`, `sitar`,
  `soprano_sax`, `steel`, `tango_accordion`, `tenor_sax`, `trombone`, `tuba`,
  `tubular_bells`, `whistle`
- `drums/` (11): `Bongos`, `Cabasa`, `Conga`, `Cowbell`, `Maracas`, `Open-Hi-Hat`,
  `Tambourine`, `Triangle`, `drum_40`, `kit_standard`, `whistle`
- `connection/` (3): `usb`, `virtual`, `wifi`

Two carry a residual hint, recorded because it is evidence and not a conclusion:

| File | Hint found inside the file |
|---|---|
| `connection/wifi.svg` | `<title>wifi_cover [#1033]</title>`, `<desc>Created with Sketch.</desc>`, group `id="Dribbble-Light-Preview"` |
| `connection/virtual.svg` | `<title>Virtual Reality icons</title>` |

### What a maintainer must decide

1. **Trace each of the 57** back to its SVG Repo page and record the per-icon licence
   and author here. Thorough and permanent, but slow.
2. **Replace the 57** with icons from a single set whose licence is known
   (Lucide MIT, Bootstrap Icons MIT, Material Symbols Apache-2.0, Tabler MIT…).
   Cheapest way to close the risk outright, and it makes the icon set visually
   coherent.
3. **Redraw them** to the house style already written down in
   `images-a-faire/README.md`.

Until one of these happens, every redistribution of `dist/`, of the Docker image or of
a fork carries 57 files of unknown licence.

---

## 6. Icons with no third-party marker — presumed in-house, **to confirm**

**43 shipped SVGs** carry no third-party marker and contain hand-written structural
comments in French that follow this project's own conventions and naming charter
(`images-a-faire/README.md`) — e.g.
`<!-- Grosse caisse (Bass Drum) - Notes 35/36 -->`,
`<!-- Clavecin (harpsichord) - GM 6 -->`. That is good evidence of in-house authorship,
so they are presumed **MIT, © the Général Midi Boop contributors**, like the rest of the
project.

It is a presumption, not a proof: §4 found three files in this same "unmarked" group
that came from Noto Emoji, Firefox OS Emoji and Emojione. Those three have been moved to
§4. The remaining 43 were checked against the whole published Iconify corpus (238 icon
sets) with no match, which is the best negative evidence available offline.

`drums/`: `drum_35`, `drum_37`, `drum_38`, `drum_41`, `drum_42`, `drum_45`, `drum_49`,
`drum_52`, `drum_58`, `drum_65`, `drum_73`, `drum_75`, `drum_78`.
`instruments/`: `acoustic`, `agogo`, `celesta`, `choir_aahs`, `church_organ`,
`clavinet`, `drawbar`, `dulcimer`, `finger`, `flute`, `glockenspiel`, `harpsichord`,
`jazz`, `kalimba`, `koto`, `melodic_tom`, `music_box`, `oboe`, `reed_organ`,
`reverse_cymbal`, `shanai`, `steel_drums`, `string_ensemble_1`, `taiko`, `timpani`,
`tinkle_bell`, `vibraphone`, `woodblock`, `xylophone`.
Root: `loading-mascot.svg`.

**Maintainer confirmation needed:** were these drawn for the project? A yes turns this
section from "presumed" into "established".

---

## 7. Repository-only images — not shipped, still redistributed

These are excluded from the Docker image and from `dist/`, but they travel with every
clone and fork of the repository.

| Location | Files | State |
|---|---|---|
| `docs/images/*.svg` | 13, all SVG Repo-marked | 12 UNRESOLVED as in §5; `bluetooth.svg` resolved in §4 |
| `docs/images/**/*.png` | 25 screenshots of the app's own UI | in-house, MIT |
| `images-a-faire/` | 59 SVG, 45 of them SVG Repo-marked | same UNRESOLVED status as §5 |

Five files in `images-a-faire/` were traced by the same method as §4 and are third-party
CC BY 4.0 / Apache-2.0 material: `guitar.svg` (`noto:guitar`), `trumpet2.svg`
(`noto:trumpet`), `saxophone.svg` (`emojione:saxophone`), `violin2.svg`
(`emojione:violin`), `drums/Hand-Clap.svg` (`twemoji:clapping-hands`).

---

## 8. Text assets

| Asset | Origin | Terms |
|---|---|---|
| `public/locales/*.json` (28 languages) | written for this project | MIT, with the project |
| `shared/gm-instrument-names.json`, `shared/gm-instrument-capabilities.json` | General MIDI 1 program names from the MMA specification, plus this project's own capability data | GM program names are a factual table; the capability data is the project's own work, MIT |
| Fonts | none bundled or fetched (`grep fonts.googleapis public/index.html` → 0 hits) | — |

---

## 9. How the icon provenance in §4 was established

So that it can be re-run and challenged rather than believed:

1. For each shipped SVG, every `d="…"` path was extracted and normalised by removing
   whitespace and commas.
2. Those signatures were searched against the full published
   [Iconify](https://github.com/iconify/icon-sets) corpus — **238 icon sets**, each with
   a declared SPDX licence — matching on the path geometry, which survives
   reformatting, minification and recolouring.
3. A file is reported here only when its path data appears verbatim in a named upstream
   icon. `accordion.svg` was cross-checked a second way, directly against
   `googlefonts/noto-emoji/svg/emoji_u1fa97.svg`: identical path data and identical
   nine-colour palette.
4. The 100 shipped SVGs not listed in §4 produced **no** match anywhere in that corpus.
   That is why §5 says "unknown" and not "not third-party": the corpus covers icon sets,
   not the illustration collections SVG Repo also re-hosts.

`node scripts/audit/licenses.mjs --assets` re-runs the bookkeeping half of this offline
(every shipped asset is registered here, marker counts still match). The corpus match in
step 2 needs the Iconify sets, which are not vendored.

---

## 10. Packaging follow-up (remediation R09 / F-157)

Attribution only counts if it reaches the person who receives the copy. Today it does
not:

- the `Dockerfile` copies neither `LICENSE` nor `THIRD-PARTY-NOTICES.md`;
- `.dockerignore` drops root-level `*.md` and re-includes only `README.md`, so
  `THIRD-PARTY-NOTICES.md` needs `!THIRD-PARTY-NOTICES.md`;
- `assets/` is copied from the builder stage, which never receives this file, so
  `assets/ASSET-LICENSES.md` does not reach the image either.

Those three lines belong to the packaging work item, not to this document.
