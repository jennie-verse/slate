# Third-party notices — slate

slate bundles everything it needs. There is no CDN, no web-font server and no
analytics; `connect-src 'self'` in the page's CSP means there is no code path
that can reach another origin at all.

Full licence texts are in `licenses/`.

---

## Libraries

### rough.js 4.6.6 — MIT

- File: `vendor/rough.esm.js` (27,748 bytes)
- Source: https://github.com/rough-stuff/rough — npm `roughjs@4.6.6`, published 2023-11-20
- Licence: `licenses/rough-MIT.txt`
- Draws every sketchy shape. This is the same renderer excalidraw.com uses, which
  is why slate's shapes look like the original's rather than merely similar.

`rough.esm.js` is a self-contained bundle with no external imports. Four MIT
packages by the same author (Preet Shihn) are inlined into it, so one notice
covers them all — but they are named here so the list is accurate:

- `hachure-fill`
- `path-data-parser`
- `points-on-curve`
- `points-on-path`

### perfect-freehand 1.2.3 — MIT

- File: `vendor/perfect-freehand.mjs` (4,532 bytes)
- Source: https://github.com/steveruizok/perfect-freehand — npm `perfect-freehand@1.2.3`, published 2026-02-01
- Licence: `licenses/perfect-freehand-MIT.txt`
- Turns pen input into a stroke outline. Dependency count: zero.

---

## Fonts

### Lexend — SIL Open Font License 1.1

- Files: `assets/fonts/lexend-400.woff2`, `assets/fonts/lexend-700.woff2`
- Source: https://github.com/googlefonts/lexend
- Licence: `licenses/Lexend-OFL.txt`
- The app's interface font, per the house standard. Falls back to Verdana.

### Virgil — SIL Open Font License 1.1

- File: `assets/fonts/virgil.woff2`
- Size: **61,248 bytes**
- SHA-256: `9976295bfe709bdea64839a4d4e9a1d436dd6eb67538399a5a0e8b8fadbcf1cf`
- Upstream path: `public/Virgil.woff2` in the Excalidraw repository
- Licence source: https://github.com/excalidraw/virgil — `LICENSE.md`
  (OFL-1.1, © 2021–present Ellinor Rapp, **Reserved Font Name "Virgil"**)
- Licence text: `licenses/Virgil-OFL.txt`
- Used only for text drawn on the canvas, never for the interface.

**Not subsetted.** Trimming the glyph set would make it a Modified Version under
OFL, which may not use the reserved name — and renaming it would put slate's
font name out of step with the original. The 60 KB ships as-is.

**Embedded in exported SVG.** When "Embed font" is on, the woff2 is base64'd
into the SVG so the drawing keeps its handwriting on a device that has no
Virgil. OFL explicitly permits embedding a font in a document.

**The binary's internal metadata does not say OFL.** Reading the file's `name`
table gives:

| Field | Value |
|---|---|
| Family | `Virgil 3 YOFF` |
| Designer | `Your Own Font Foundry` |
| Licence | `Freeware for personal use! For commercial license please go to https://www.yourownfont.com/ and make a donation!` |

The upstream `excalidraw/virgil` repository and Excalidraw's own font page both
state OFL-1.1 by Ellinor Rapp. yourownfont.com is a service that generates a
font file from someone's handwriting, and it stamps that string into everything
it produces — so this reads as generator boilerplate rather than a competing
grant. That is an interpretation, not a settled fact, and it is written down
here so nobody has to rediscover the discrepancy later.

slate is a personal, non-commercial app and does not distribute the font on its
own, which sits inside either reading. If that ever stops being true, the clean
replacement is **Excalifont** (OFL-1.1, explicitly personal and commercial use,
available from the `@excalidraw/excalidraw` npm package as seven unicode-range
files totalling roughly 64.8 KB).

Note that the `@font-face` family name in `assets/app.css` is `"Virgil 3 YOFF"`
because that is the font's actual internal name — declaring `Virgil` would not
match and the face would silently fail to load.

---

## Not bundled

Excalidraw itself is **not** included. slate reads and writes the
`.excalidraw` file format and matches its constants and rendering approach, but
shares no code with it. Excalidraw is MIT licensed
(https://github.com/excalidraw/excalidraw); the file format and constants were
read from that source to make round-tripping work.
