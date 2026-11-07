# Timeline fonts

Run `corepack pnpm fonts:fetch` after installing dependencies. This is an explicit
network operation; installation itself remains usable offline. Font binaries and
their license texts are written into the ignored `files/` directory.

The manifest pins every download and its SHA-256 digest, including license texts.
The fetcher verifies cached files on every run and deletes a mismatched file before
failing. Rerun the command to download a deleted file.

Smiley Sans is published only as a ZIP. Its official v2.0.1 release is the single
approved archive exception: the fetcher verifies the archive hash, reads its central
directory, and extracts only `SmileySans-Oblique.ttf` in memory into the fixed
`smiley-sans.ttf` destination. It then verifies the font hash. Stored and deflate
entries are supported; encrypted, ZIP64, multi-disk and oversized entries are rejected.
The archive is never written to disk, and the license is fetched separately.

Noto Sans SC uses a pinned static Regular OTF. The newer variable TTF defaults to
weight 400 in Chrome but weight 100 in libass, producing different glyph widths
and stroke weights. The static font keeps preview and export on the same instance.

Public font metadata prefers the English typographic family (name ID 16, then 1).
Export resolves the English legacy family alias (ID 1, then 16) for libass only:
Smiley Sans needs `Smiley Sans Oblique` for Windows libass to select its file.
The original font bytes, manifest families and public metadata stay unchanged.

Node 24's environment proxy support is enabled automatically by the fetcher when
`HTTPS_PROXY` or `HTTP_PROXY` is set. On the current Windows development machine:

```powershell
$env:HTTPS_PROXY = 'http://127.0.0.1:10808'
corepack pnpm fonts:fetch
```

Both studiod and the web host resolve `resources/fonts/files/` relative to their
source or bundle location, independent of the launch directory. Set `VIS_FONTS_DIR`
to an absolute directory to override this location in both processes. Packaged
applications should include the font files together with their license files.

Project uploads accept `.ttf` and `.otf` files up to 50 MiB. The importer reads the
font's family name without running font programs. Uploaded fonts remain project
assets and are never placed on the canvas. Users are responsible for font licensing.
