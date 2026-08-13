# slate

A private, offline-first drawing canvas for iPad and iPhone.
Shapes, arrows and handwriting on an infinite canvas — stored on the device,
exported as PNG, SVG or `.excalidraw`.

**Live:** https://jennie-verse.github.io/slate/

- No server, no login, no analytics, no CDN. `connect-src 'self'` means there is
  no code path that can send a drawing anywhere.
- Reads and writes the `.excalidraw` file format, so drawings move to and from
  excalidraw.com without losing data.
- Static files only — no build step.

Korean documentation is in [`docs/`](./docs/README-KO.md).
Bundled libraries and fonts are listed in [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md).

```bash
npm test          # 65 tests, no browser required
```
