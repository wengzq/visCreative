# README screenshot capture

From the repository root, after installing dependencies and building:

```sh
npx --yes pnpm@10.34.9 install --frozen-lockfile
npx --yes pnpm@10.34.9 fonts:fetch
npx --yes pnpm@10.34.9 build
PATH="/opt/homebrew/bin:$PATH" VIS_SHOTS_FFMPEG=/opt/homebrew/bin/ffmpeg VIS_SHOTS_OUT=/tmp/vis-next/shots npx --yes pnpm@10.34.9 --filter @vis/web readme-shots
```

The example uses the macOS ffmpeg location. On Windows/Linux, put ffmpeg on
`PATH` and omit `VIS_SHOTS_FFMPEG`, or point it at the installed executable.
Before capturing on a shared machine, run `pgrep -fl vitest` and wait for any
full check or e2e round to finish. Never run against a development daemon.

The command typechecks the harness, starts a fresh daemon and project directory
for each locale, captures both `en` and `zh-CN`, then shuts down the stack and
removes its data and project directories. Project workspaces and the fake-Codex
home stay outside the daemon data directory so macOS isolation stays enabled.
It is separate from `pnpm check` and `test:e2e`.

The default destination is `<os.tmpdir()>/vis-readme-shots/<locale>/<name>.png`.
`manifest.json` records the locale/name sets and viewport. Every PNG is
3200 × 2000 pixels, captured at a 1600 × 1000 viewport with a device scale factor
of 2 and reduced motion. Set `VIS_SHOTS_OUT` to choose another destination.
Failures leave `failure.png` and `failure.html` at the destination root.

Chrome and ffmpeg must already be installed. `VIS_CHROME_PATH` overrides browser
discovery, and `VIS_SHOTS_FFMPEG` overrides the render encoder executable.
The export service uses ffmpeg from `PATH`. The harness uses the bundled Noto
Sans SC font when present, then an installed Noto CJK font on Windows/Linux;
set `VIS_SHOTS_FONT` to an installed CJK `.ttf` or `.otf` on other systems.
No font, image or script is downloaded during capture.

The sample is “Mountain & Sea”, episode one “First Light”, with localized
Chinese content in the Chinese run. Illustrations are source-controlled
HTML/SVG scenes in `artwork.ts`; the existing local render provider creates
videos, and ffmpeg extracts the still images. The source hash, duration and
frame rate key an immutable cache at `<os.tmpdir()>/vis-readme-render-cache`.
Removing that cache causes the next run to render every scene again. The
twenty-second edit uses the same script-assembly helper as the UI and exports
through `media.process`, including captions, emblem and mock music.

Only fake Codex runs. Its additional capture behavior is enabled exclusively by
`.vis-readme-shots.json` in the isolated work item's directory; ordinary e2e
work directories have no such file. Work reports, changes and before/after
previews come from real gateway/MCP operations. The provider settings shot
configures a demo Ark entry and a dummy key in the memory secret store; it
never submits an Ark job or accesses the operating system credential store.
The browser blocks external requests, and render-provider pages also run offline.

The existing names are `hero`, `script`, `timeline`, `library-media`,
`library-settings`, `series`, `board`, `review`, `inbox`, `versions`,
`context-menu`, `providers`, `timeline-assemble` and `timeline-inspector`.
`script-prompts` shows per-shot prompts and `script-cast` shows reference cards.
Additional choices are `hero-b` (no selected node) and `timeline-overlay` (placement handles).
New scenes are `writing`, `writing-review`, `previz`, `previz-editor`, `skills`,
`skill-draft`, `turn-view`, `cleanup-card` and `scene-editor`. `new-scenes.ts` writes a localized
manuscript and submits an anchored suggestion through fake Codex, draws panels
with real pointer input, extracts blockout frames through the user API, saves
and copies an author skill, renders a local session result, queues a message,
and requests child cleanup through fake Codex. All suggestions and approvals
remain pending in their captures. The skill-copy fixture edits only a file in
the isolated project to show both update and local-edit states.

`script` shows the complete five-shot table with cast chips. The compact script
card in `hero` and `timeline-assemble` previews three shots, as the product does.

The harness changes ordinary demo node layout/purpose through the API to frame
each surface. It does not modify the product DOM, CSS or UI state internals.
Relative board labels stay at “Just now”; message clock labels can differ
between runs. IDs and ports are intentionally not fixed, and do not appear in
the final compositions.

## Updating the README images

The READMEs use 24 of the 26 captures per locale as WebP. Inspect every final
capture in both languages, then run the publisher. It reads the image names
from each README, verifies them against the capture manifest, and converts
with ffmpeg at quality 90. No pixels, product DOM or CSS are edited after capture.

```sh
VIS_SHOTS_FFMPEG=/opt/homebrew/bin/ffmpeg node apps/web/readme-shots/publish.mjs /tmp/vis-next/shots
```

Keep the visual review report and PNGs under `/tmp`; only the referenced WebP
files belong in `docs/images/`. Known product overlaps and wording issues are
listed in `docs/known-issues.md`. Record fixture workarounds and new issues in
the capture report instead of changing product code for a screenshot.
