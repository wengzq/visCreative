# 0036 · Transparent video from the local renderer

Status: implemented (steps a and b)

Date: 2026-11-05

Builds on [0024](0024-timeline-editing.md) (timeline overlays), [0029](0029-shot-previz.md) (local render) and the media task path used by `media_process`.

## Background

An author asked for an 8-second transparent data card to lay over a phone review video. The Agent reported that local transparent rendering was blocked by Chrome permissions and delivered an MP4 it could not call finished.

Two separate things happened. The Agent tried to start Chrome inside its sandbox, which correctly denies Chrome's files under the user's home. That isolation protects keys and data and stays as it is. The approved route is the `render` provider, which runs outside the sandbox, but its output is fixed: opaque frames encoded as H.264 `yuv420p` in MP4. So no route could produce transparency.

## Decision

Add transparency to the `render` provider. Do not widen the sandbox.

- **Step a:** transparent WebM that previews in the browser and works as a timeline overlay.
- **Step b:** export a transparent video as MOV (ProRes 4444) for other editing software.

## Step a: transparent WebM

**Contract.** `render` video params gain `transparent: boolean`, default `false`. Existing renders are unchanged.

**Rendering.** With `transparent`, frames are captured with the page background omitted and encoded as VP9 with alpha (`libvpx-vp9`, `yuva420p`) in WebM. Output mime is `video/webm`. The page itself must leave its background transparent; the provider does not key out colours.

**Missing encoder.** If ffmpeg lacks `libvpx-vp9`, the job fails with a clear, localized reason, and never silently falls back to an opaque file.

**Verification.** A delivered transparent file must really carry alpha. Tests decode frames with `libvpx-vp9` and check that a corner pixel is transparent and a drawn pixel is opaque. ffmpeg's native VP9 decoder drops alpha, so every path that reads these files must select `libvpx-vp9` explicitly.

**Preview.** Transparent video shows over a neutral checkerboard on canvas cards, the session result card and full preview, so transparency is visible rather than looking like a black or white background. Assets carry a `hasAlpha` fact from probing, including imported WebM files with alpha. Posters keep working; a poster may be flattened over the same checkerboard.

**Timeline.** A transparent clip on an overlay track keeps its alpha through preview and export. A transparent clip on the main video track composites over black, as any overlay on no video does today.

**Agent guidance.** The render and motion guidance says: render through the `render` provider and pass `transparent: true` for transparent output; do not start Chrome yourself, because the sandbox blocks it. A blocked local attempt is a reason to use the provider, not to report the task as impossible.

## Step b: export as MOV

A transparent or ordinary video asset can be exported as MOV ProRes 4444 from its download menu, as a free local media task. Output keeps alpha (`prores_ks`, profile 4444, `yuva444p10le`), reading WebM through `libvpx-vp9`. The result downloads as a file, and also becomes a version on request only if that proves necessary in use. Browsers cannot play ProRes, so this is a delivery format, not a canvas format.

ProRes files are large. The dialog shows the expected size before starting, and the task follows existing cancellation and failure rules.

## Principle check

- Mechanism: an output option and honest failure. Nothing here decides how a motion graphic should look.
- Security: the sandbox is unchanged.
- Cost: local and free, so no quota applies.

## Testing

- Unit: params default, encoder arguments, mime, missing-encoder failure, `hasAlpha` probing.
- Integration with real ffmpeg and Chrome: alpha survives render, timeline overlay export and, in step b, MOV export.
- Browser: checkerboard appears only for transparent media, in card, result and preview.
- A fake Codex scenario submitting a transparent render.

## Not in scope

- Chroma keying existing footage.
- Other alpha formats such as HEVC with alpha or PNG sequences.
- Transparent output from paid video models.


## Implementation notes

Step a stores nullable `hasAlpha` on asset versions (generated migration 0029), exposes it in asset and slot views, and preserves old versions without inventing a fact. VP9 alpha is detected from the WebM `alpha_mode` stream tag as well as alpha pixel formats. All visual ffmpeg readers choose libvpx for alpha VP9; posters flatten onto a neutral checkerboard, and main timeline clips premultiply over black. Existing opaque render keys and files remain recoverable after restart.

The real Chrome/ffmpeg regression decodes RGBA pixels for transparent corners, opaque drawings, extracted PNGs, checkerboard posters, blue underlays and black main-track backgrounds. Fake Codex submits through the provider. Removing omitted-background capture fails on alpha 255 instead of 0; removing the timeline decoder fails on a black corner instead of the blue underlay. No sandbox or paid provider behavior changed.

Step b adds UI-only `video.exportMov` local tasks, encoded with `prores_ks` profile 4, `yuva444p10le` and 16-bit alpha; audio is preserved as PCM. The download menu previews an approximate size range of 0.5–2 bytes per pixel per frame (30 fps when older metadata has no fps); content and alpha determine the actual size. Unknown dimensions/duration are shown honestly instead of inventing an estimate. Neither assets, versions, nodes nor undo entries are created.

The gateway rejects Agent export starts; `media.cancel`, `media.dismiss` and `media.exportDownload` are UI-only (there was no existing public local-task cancel method). Cancellation reuses `cancelTask`, scheduler and ffmpeg abort handling. The web host serves `/exports/<spaceId>/<taskId>` using its existing token, Host and Origin checks, with no client-supplied path. Download metadata is persisted on the task, while paths are returned only by the UI-only download method.

Delivery files live under the project's daemon data directory at `cache/exports`. Dismissal deletes the file; it becomes unavailable after one hour and a one-minute cleanup timer removes expired files. Closing/deleting the project clears all delivery files after stopping its tasks, and startup clears any files orphaned by a crash. Export tasks remain in history with their download metadata removed. The deletion recovery path also removes the export cache. There is no request to save as an asset version because no use case has established that need. Linux CI's configured static FFmpeg 9 and Windows `ffmpeg-full` were not executed on this macOS host; their encoder availability remains unverified. Local `/opt/homebrew/bin/ffmpeg` provides both `libvpx-vp9` and `prores_ks`.


Validation includes real transparent and ordinary MOV decoding (transparent and opaque pixels plus ProRes profile and audio checks), gateway denial for Agents, HTTP auth/Host/Origin/path boundary tests, cancellation and expiry/close/deletion cleanup, and real-browser download, cancellation/retry, checkerboard and timeline-compositing checks. A ProRes pixel-format mutation drops alpha and fails the transparent-corner check. No real vendor API or real Agent was used.


Final local validation (2026-11-05): `pnpm check` passed (231 files passed, one skipped; 2,959 tests passed, 18 skipped), followed by `pnpm build`. The full browser suite passed twice in succession against that build (41 files and 303 tests per round). No production code changed between those rounds. Screenshots and decoded MOV samples, full logs and the implementation report are under `/tmp/vis-next/rfc36`.
