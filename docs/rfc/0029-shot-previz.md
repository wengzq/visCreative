# 0029 · Shot previz: key panels, blockout renders and previz-guided generation

Status: accepted, in progress (steps a–c implemented with fake-Agent coverage and a real-Codex evaluation below; real-Agent acceptance incomplete and Windows rendering deferred; e on hold); Windows follow-up revalidation pending (2026-11-05)

Date: 2026-11-04

> Render library follow-up (2026-11-07): `/lib/anime.js` (anime.js 4.5.0, MIT) replaces bundled GSAP, alongside the existing rough.js and three.js modules. Rendered pages still use only `window.vis.seek(t)` in seconds; paused anime.js timelines use milliseconds with no automatic main loop, and plain JavaScript remains an equal option. Authors may provide separately licensed libraries directly in `<dataDir>/render-libs/`; these cannot override built-ins, escape the folder through symlinks, or add Agent write permissions. An absent script fails with localized `render.lib_missing` and its filename. This changes library distribution, not the previz decisions or historical evaluation results below.

Builds on [0016](0016-canvas-organization.md) (code rendering), [0021](0021-node-components.md) (node operations, image grid split), [0023](0023-script-nodes.md) (shots, first and last frames, batches), [0024](0024-timeline-editing.md) (full-screen editor pattern, assembled timelines), [0026](0026-agent-instructions.md) (guides read on demand) and [0027](0027-asset-library.md) (asset versions as generation inputs).

## Background

- A script describes shots in words, and first frames come from prompts. Users have no way to say "the character stands here and the camera moves like this" except in text.
- Nothing in the product draws. Existing `<canvas>` uses are waveforms and previews.
- The back half already exists:
  - `generation.submit` accepts asset versions as `inputs` and structured `frames`.
  - `planScriptBatch` (`services/studiod/src/script-batch-plan.ts`) uses the newest node linked to a shot and role, so a user-supplied first frame already skips generation.
  - `render/html` turns HTML into video. It is free, and image inputs are available to the page at `/input/<n>`.
  - `asset_frames` and `video.frame` extract frames.
  - The web host's `POST /upload` stores browser-produced bytes through `asset.import`.
- **Images can reach video models today; videos cannot.** Panel pictures and blockout frames work as first and last frames, and as reference images within each model's adapter limit: Ark 9, `kling-3.0-omni` 7, `kling-4.0` 10, `wan2.7-r2v` 5, MiniMax H3 9, Gemini Omni 3. The limit is an adapter choice, not a claim about the vendor. A video input is rejected by every adapter. That is our gap, not the models': Ark documents `reference_video` for Seedance 2.0, but see §9 for what it takes to use it.
- A model call uses frames or reference images, not both: Ark ignores `inputs` images when `frames` is set, and the batch planner sends no references with frames.

## Goals

1. A **shot previz** node (镜头预演): an ordered set of panels, each a key picture, drawn in the app or imported.
2. Panels can link to shots. Several panels can link to the same shot.
3. Three ways forward from the same panels:
   - **Blockout:** an Agent turns the panels into a grey-model previz through code and rendering.
   - **Previz-guided:** generate the video with the previz as a reference.
   - **Direct:** skip the previz and generate the video from the panels.

## Out of scope

- Layers beyond one underlay and one sketch layer, selections, transforms and a brush engine. Users who need them draw elsewhere and import.
- Editing a blockout by hand in the app. The Agent owns the code; the user gives feedback in the session.

## Design

### 1. Node and data

A new `previz` member of `NodeKind` and `CanvasNodeKind`, with its document in the main slot, following `script` and `timeline`. Canvas ops gain `previz.set` with `expectedRevision`.

```ts
type PrevizDoc = {
  version: 1
  rev: number
  aspectRatio: '16:9' | '9:16' | '1:1' | '4:3' | '3:4' | '21:9'
  panels: PrevizPanel[]                 // reading order, at most SCRIPT_LIMITS.shots
}

type PrevizPanel = {
  id: string
  rev: number
  underlay: string | null               // imported image, asset version id
  sketch: string | null                 // transparent drawing layer, asset version id
  image: string | null                  // flattened PNG; what everything else reads
  note: string                          // action, camera move, anything the picture cannot say
  durationSec: number | null            // pacing in the blockout and assembled timeline
  shot: { scriptNodeId: string; shotId: string } | null
  use: 'composition' | 'frame'
  frameRole: 'first' | 'last' | null    // meaningful when use is 'frame'
  blockout: string | null               // frame extracted from the blockout, asset version id
}
```

- Panel order and shot order are independent. A script is optional: an unlinked previz still draws, imports, renders and generates per panel.
- Deleting a previz keeps generated nodes, and a deleted shot leaves a stale link, as in 0023 §2.
- Pictures are asset versions, so each save is a version with history. Session undo lives in the editor.

### 2. Panel sources

- **Draw:** pen, eraser, colour, size and undo on a native canvas through pointer events, with tablet pressure. No new dependency.
- **Import:** file picker, drag or paste onto a panel. The image becomes the underlay and can be drawn over. Dropping several files creates one panel per file, in name order.
- **Split a page:** a photographed storyboard page splits into panels. `image.gridSplit` allows only 2–3 rows and columns and creates canvas nodes, so the editor reuses its cropping with a target of panels rather than the operation as is.
- **From the canvas:** an existing image node can fill a panel.

The editor is full screen, opened from the card or by double click, like the timeline. Saving uploads the changed layers and the flattened PNG through `/upload`, then writes `previz.set`. The upload `requestId` derives from the content hash, so a retry cannot create a second asset. A revision conflict shows the same banner as the timeline.

### 3. Three paths

**Stage separation (maintainer, 2026-11-04).** Previz is free preparation and review; final generation is a separate paid stage. One node remains, with separate entries and wording. The full-screen editor contains drawing, import, notes and duration, plus a free Render previz draft action, with no model picker, generation prompt or generation host ports. The canvas popover has labelled Previz and Generation sections: linking, image-use choices and Set as first/last frame are free in Previz; prompt, model and final Generate actions live in Generation, with a Paid marker driven by the chosen provider's `needsKey`. Mock and render have no marker. Render previz drafts a free local blockout request in the current session composer; it never sends automatically. There is no confirmed state or confirm-previz gate. A request to "make a previz" means render only and never paid models; an explicit "generate" request invokes the guide's asking rules.

| | Blockout | Previz-guided | Direct |
|---|---|---|---|
| Needs a render | yes | yes | no |
| Paid calls | none for the render | first frames, then video | video, plus first frames for `composition` panels |
| Input to the first frame | not applicable | blockout frame, else panel image | panel image |
| Who starts it | user asks the Agent | user, through the script batch or panel action | user, through the script batch or panel action |

**Blockout.** The user asks the project session, or **Render previz** adds a node reference and draft to the current session composer without sending. The action appears in the card footer and full-screen editor header. From the editor it saves first, closes only on success and focuses the composer; a save failure or conflict leaves the editor open and adds no draft. Missing durations do not block drafting: the request asks the Agent to gather them. The Agent reads panels, notes and durations, writes a code node and submits it to `render/html` with panel images as inputs. A new guide (`vis guide previz`) covers the method. The resulting video node includes the previz node in `node.setInputs`, retaining its code input, and links to the shot with role `previz` when it belongs to one. The card uses the newest completed associated video; a video assigned another shot role is not a blockout. Its footer area shows a poster, play control and **Use blockout frames**. A player mounts only for playback or preview, following the canvas poster rule. After a render, the user can extract each panel's frame into `panel.blockout`; the extraction point is the panel's start time in the blockout. The UI calls `previz.extractBlockout` with the current main-slot `expectedRevision`, rereads and retries once on conflict, and localizes missing-duration errors with panel numbers and notes. Tiles retain `image` as their picture and mark extracted blockout frames; the composition popover states that it uses the blockout frame.

**Previz-guided and direct.** These differ only in the picture used, and both depend on what the panel is:

- A **sketch cannot be a first frame.** A first frame is where the video starts, so a sketch would give a sketch-styled video. `use: 'composition'`, the default for drawn panels, sends the picture as a reference for generating a finished first frame. The user checks that frame as in 0023, and the video follows.
- A **finished image can.** `use: 'frame'` creates an image node linked to the shot as `first` or `last`. The batch planner picks it up with no change, since it reads the newest node for that shot and role.

Several panels on one shot: the first in panel order is the first-frame candidate. A later panel with `frameRole: 'last'` is the last frame. Others are extra composition references, kept only while the model's reference limit allows.

### 4. Batch changes

- In `frames` mode, the first-frame step's inputs gain the shot's composition picture: `panel.blockout ?? panel.image`.
- Composition comes first in the reference budget, then continuity, cast and style. Today's cast and style capacity logic runs after it.
- If a model accepts no reference images, the composition picture is dropped and the batch estimate says so. It never fails silently.
- The prompt must say to follow the layout, not the drawing style. The Agent writes this in `framePrompt`; the `script` and `previz` guides state the rule.
- Batch confirmation, daily limits and `requestId` idempotency do not change.
- Last frames stay as they are: the planner generates one only with `endState`, and the video step uses any existing `last` node.

### 5. Roles

`ShotRole` also types batch steps, so it stays `first | last | video`. `ShotLink.role` widens to `ShotRole | 'previz'`. Script rows show a dashed blockout thumbnail labelled “Blockout · Previz only”, distinct from finished first/last/video outputs, while `currentShotNode`, batches and `assembleScriptTimeline` keep treating only real outputs as results. This guarantees a blockout is never exported as a finished shot.

### 6. Agents and permissions

- Agents read previz documents and panel images through existing canvas and asset tools.
- Agents may add panels, and edit `note`, `durationSec`, `shot`, `use` and `frameRole`. Only the user sets `blockout`, through Use blockout frames; `previz.extractBlockout` is UI-only and the gateway refuses Agent `previz.set` changes to it.
- Agents may not change or remove `underlay`, `sketch` or `image` on a panel that has one. The gateway compares the old and new document for `agent` callers and returns an error; this does not rest on prompt wording.
- The user can do everything, and no agent write stops an open editor: the conflict banner handles it.

### 7. Blockout rendering library

Pages can load only `gsap` and `rough.js`, which have no 3D. Grey models with real perspective and camera moves need one of:

- **CSS 3D and 2D canvas (no dependency):** enough for planes, simple boxes and dolly or pan moves, and awkward for anything else.
- **three.js as a local `/lib` file:** real geometry and cameras.

Note (2026-11-06): [RFC 0037](0037-interactive-scene-nodes.md) revises the "never reaches the web client" point below: the scene editor loads three.js lazily in the web client, while render pages keep their local `/lib` copy.

**Decision (maintainer, 2026-11-04): add three.js in step c.** A spike passed on macOS (2026-11-04; Apple M5 Pro, Chrome 152, three 0.187.0, unmodified provider, 5 s at 30 fps with two capsules, a box and two textured planes):

| | three.js | CSS 3D |
|---|---|---|
| 1920×1080 render | 7.1 s | 12.3 s |
| 1280×720 render | 5.5 s | 11.3 s |
| Two renders identical | yes at both sizes | not at 720p: 2 of 150 source frames differed, cause not found |

- WebGL 2 ran on hardware (ANGLE Metal) with no extra launch flags. Peak process-tree RSS at 1080p was about 2.2 GB.
- three is MIT. A full esbuild ESM bundle is 731 KiB, or 185 KiB gzipped. It is served only to render pages, through `libs`, and never reaches the web client.
- Pages must finish loading textures before defining `window.vis`, and set `preserveDrawingBuffer` on the renderer.

**Windows passed on one machine (2026-11-04).** An RTX 3070 Ti through D3D11 with default flags took 8.1 s at 1080p and about 4.9 s at 720p, with identical repeat renders. Machines without a usable GPU are unverified (see `docs/known-issues.md`); if they fail, blockouts there fall back to CSS 3D and the guide must say so. The sample stays in the test suite as `providers/render/fixtures/blockout.html`.

### 8. Where the code lives

A new package, `packages/previz/ui`, named `@vis/previz-ui`, follows `packages/timeline/ui`:

- `pnpm-workspace.yaml` gains `packages/previz/*`.
- `scripts/check-boundaries.mjs`: add `packages/previz` to `dirs`, `'previz-ui': ['protocol', 'ui-kit']` to the rules, and `previz-ui` to `web` and `desktop`.
- `scripts/check-i18n.mjs` scans its source directory.
- The editor, drawing surface and panel list live in the package, with copy in its `messages.ts`. `apps/web/src/client` mounts it through a host object, as with `timeline-editor.ts`.
- `canvas-ui` never imports it. The canvas card stays in `packages/canvas/ui` and receives "open previz" from the host.
- Document rules and server validation sit with the timeline and script equivalents in `packages/canvas/core`, unless the code shows a better fit.

### 9. Video references (step e, on hold)

Checked 2026-11-04 against official docs ([Ark create task](https://docs.volcengine.com/docs/ark/create-video-generation-task-api?lang=zh), [Wan reference-to-video](https://www.alibabacloud.com/help/en/model-studio/wan-video-to-video-api-reference), [DashScope temporary files](https://www.alibabacloud.com/help/en/model-studio/get-temporary-file-url)). Nothing here was tried against a real API.

**Seedance 2.0 on Ark is the only fit found so far.** Content item: `{ type: 'video_url', video_url: { url }, role: 'reference_video' }`.
- `url` is a public URL or `asset://<id>`. Base64 is documented for images and audio, not for video.
- Limits for the 2.0 family: at most 3 videos, 2–15 s each, 15 s in total, 200 MB each, mp4 or mov, H.264 or H.265, 24–60 FPS, aspect ratio 0.4–2.5, 407,696–8,295,044 pixels. Blockouts must therefore render at 24 FPS or more and be cut per shot.
- First-frame, first-and-last-frame and reference modes are mutually exclusive. A shot using a video reference has no first frame to check. Panels can go with it as `reference_image`, and the prompt names them (`@视频1`-style naming is documented for 2.5; confirm it for 2.0).
- Billing: Ark's page does not say how input video counts. Press reports from March 2026 give a lower per-token rate with video input (¥28 against ¥46 per million at 480p/720p). The batch estimate must not claim a price until this is known.

**`wan2.7-r2v` does not fit.** Its reference video is the subject reference for a main character, and the docs say to avoid background-only or empty-scene videos, so it does not carry camera movement. It also bills input plus output duration. Its DashScope temporary `oss://` upload needs only the API key, but it is documented for development and testing only and is not stated to work with Wan.

**Kling** video references were not checked.

**Getting a local file to a URL.** The `asset://` route does not avoid this: `CreateAsset` also takes a URL, needs separate AK/SK credentials, is asynchronous with no SLA, and each asset group is described around a verified real person. The proposal is an optional **media hosting** setting for S3-compatible storage, such as Volcengine TOS:
- The endpoint, bucket and key id live in settings; the secret lives in the credential store under its own entry.
- The adapter uploads the clip and sends a presigned GET URL with a short expiry. Objects are keyed by content hash and deleted after the task settles.
- A presigned URL is a secret: it never reaches logs, events, errors or job records. Requests are signed in-process, with no new dependency.
- Intent is persisted before the paid create, as in every adapter. An upload failure happens before the create and is safe to retry.

Contract additions: a provider capability for reference videos with limits per model, `ProviderInputMetadata` accepting video, and a batch option that chooses reference mode per shot.

**Gate.** Before building, confirm that Seedance follows the camera and blocking of a grey model. A manual run in the Ark console with a sample blockout answers this without code. It needs the maintainer's approval, since it is a paid generation.

## Contract changes

- `NodeKind`, `CanvasNodeKind`: add `previz`, with a storage migration (`pnpm --filter @vis/storage db:generate`).
- New `packages/protocol/src/previz.ts`: `PrevizDoc`, `PrevizPanel`, limits.
- `canvas.apply`: add `previz.set`. Node creation accepts an empty previz.
- `ShotLink.role`: add `previz`. Agents do not need to set it; see the evaluation findings below.
- `batch.ts`: estimate reports dropped composition references.
- New guide topic `previz`; `script` and `code-render` guides link to it.

## Steps

- **a. Node, editor and sources.** Contract, card, full-screen editor, drawing, import and multi-file drop. Final-output generation lives on the canvas in step b.
- **b. Shots and batches.** See the [UI spec](0029-ui-spec.md): the card becomes a strip, the editor stays free and previz-only, panels are selected on the canvas with separate labelled Previz (free setup) and Generation (final output, with a needsKey-based Paid marker) sections, then links, `use` and `frameRole`, composition inputs in the planner, previz status in script rows, and the `previz` guide with its asking rules.
- **c. Blockout.** three.js as a `/lib` file, the blockout part of the `previz` guide, Render previz drafts, the `previz` role, frame extraction into panels.
- **d. Acceptance.** Real-model trial of sketch-to-frame fidelity. It needs the maintainer's approval, an isolated data directory and tight limits.
- **e. Video references.** On hold (maintainer, 2026-11-04): the hosting it needs is too much for now. §9 keeps the findings for when it resumes.

a comes first. b and c can run in parallel after a. Page splitting can land with a or later.

## Testing

- Contract tests for the document and `previz.set`, and gateway tests for the agent drawing rule.
- Planner unit tests: composition order and budget, dropped references, a `frame` panel skipping generation, a `previz` node ignored by batches and assembly.
- Browser e2e with fake Codex and mock providers: draw, import, reorder, link two panels to one shot, batch, conflict banner. Selectors use `aria-label`; the drawing surface is driven through pointer events.
- `render/html` end to end with panel images as inputs, free and local.
- No test calls a paid service.

## Risks

- **How well a sketch steers a first frame is unknown** and varies by model. There is no shared strength parameter, so step d decides whether defaults or prompt guidance need to change.
- **Agent-written 3D is untested.** Blockout quality depends on the model, and the 0026 evaluation runner should cover it before step c is called done.
- **Large documents:** each panel holds three pictures plus history. The card shows thumbnails through the existing preview cache; `perf` should include a 100-panel previz.

## Follow-ups

- Keyframes as multi-image references for video models that accept them (Kling Omni, `wan2.7-r2v`, MiniMax H3).

## Decisions (maintainer, 2026-11-04)

- The feature is named shot previz (镜头预演). It describes key shots, and several panels can link to one shot.
- Users can draw panels or import finished images.
- Three paths: Agent blockout through code and rendering, previz-guided generation, and direct generation.
- Drawing covers pen, eraser, colour, size, undo and one underlay.
- three.js is added in step c; the Windows run waits for a Windows machine (§7).
- Previz is a new component in its own package (§8).
- Previz and final generation are separate stages on one node: the full-screen editor is free previz only; the canvas popover separates free Previz controls from final Generation controls and marks key-requiring providers Paid. "Make a previz" never invokes paid models; "generate" triggers the asking rules. Render previz is the free draft action introduced in step c, with no confirm-previz state or gate.
- The canvas card becomes a horizontal strip, and panels are selected and generated on the canvas (UI spec). If the strip works badly, it changes.

## Open questions

When step e resumes:

- Does Seedance follow a grey-model blockout well enough (§9 gate)?
- Media hosting: is S3-compatible storage acceptable, and does the maintainer have a bucket?
- How does Ark bill input video?

## Step a implementation notes (2026-11-04)

- The canvas card shows the first four panel images through a new image-only `media.preview` kind `thumbnail`, served at `/previews/<space>/<version>/thumbnail` and backed by the existing local poster cache. The video-only `poster` route and its callers retain their previous behavior.
- `@vis/previz-ui` owns the full-screen editor, pointer drawing surface, panel list and local draft/undo. The web shell injects asset and save ports; step b removes the editor generation ports and model picker, leaving the editor previz-only; `canvas-ui` only renders the card and calls the injected open action.
- The v1 document already contains every §1 field, including shot, use, frameRole and blockout. Step a exposes note, duration and aspect ratio; panel IDs stay stable through reorder. Document/panel `rev` values travel with the document, while the main slot's `expectedRevision` is the authoritative concurrency guard. Limits are 200 panels, 4,000 note characters and positive durations up to 3,600 seconds.
- Drawing is one transparent sketch over one optional underlay, with native pointer capture, coalesced pointer samples and tablet pressure. Erasing affects only the sketch. Changing the aspect ratio fits both layers without cropping and rebuilds the flattened PNG. Undo retains the session's document snapshots, including picture versions; it resets when the user explicitly loads the remote version or closes the editor.
- The picker, panel drop, panel paste and canvas image selector fill a panel's underlay. Multi-file drops add panels in natural filename order. A single import onto an existing panel retains its sketch. Panel rows support drag reorder and accessible move buttons.
- Browser blobs remain local until a save uploads changed layers and the flattened PNG to `POST /upload`, then commits `previz.set`. SHA-256 supplies the upload request ID. `asset.import` accepts an optional verified `contentHash`: when supplied, idempotency fingerprints the bytes instead of the temporary staging path, so an upload retry (including after a host restart) reuses the original asset version. Existing path-based imports retain their prior identity rules. Slot history pins all saved picture versions.
- Saving is serialized; edits during an upload remain in the next save. The editor recognizes its own events before the RPC reply, preserves unsaved local content on failure and exposes retry. External edits after local editing show the timeline-style conflict banner, session name, side-by-side versions and Load their version action. Drawing/import work in progress also marks the local editor as edited.
- The gateway compares agent previz writes across the whole operation batch. It refuses changes or removal of any existing non-null underlay, sketch or image, removal of their panel, or deletion of a previz node containing protected pictures. Metadata updates and new panels remain allowed. Generic slot edits cannot clear a previz; server validation checks every picture (including blockout) references an existing image version.
- Revised in step b: per-panel final image generation is a canvas action using `generation.submit` with the flattened panel as an asset-version input, the existing image model picker and a regular `new_node` target beside the previz. The drawing editor has no generation controls or host ports. Step b assigns existing shot roles when linked.
- First test round (2026-11-04): right-clicking a panel in the list, or the stage for the current panel, opens a menu to insert, duplicate, import, move or delete. The canvas card numbers its panels, shows their notes and counts the panels it cannot fit. Step b moves the model picker to the canvas Generation section; its popover opens beside its trigger and has corner hit-test and relative-position coverage.
- Deferred from the full RFC: page splitting; shot-link controls; use/frameRole actions; batch composition changes; the previz shot-link role and blockouts; Agent guides; performance measurements for a 100-panel previz; real-model acceptance and video references. These are outside step a. No new external dependency was added, and tests use only mock providers and fake Codex.


## Step b implementation notes (2026-11-04)

- The canvas card is a horizontal strip of all panels, with local selection, keyboard navigation, directional wheel handling, end arrows, shot and stale-link badges, and a popover at the same bottom-center anchor as the image prompt panel. Vertical wheels and pinch gestures remain canvas navigation. The popover labels free Previz setup separately from final Generation; the latter reuses the prompt editor, model picker and parameter controls and shows Paid when the chosen provider needs a key; its root overlay keeps controls above the minimap. Double click opens the drawing editor at the chosen panel.
- Composition, first-frame and last-frame actions use existing generation and canvas operations. Materialized pictures and generated outputs receive `node.setMeta` shot links with the existing first, last and video roles. Free Set as first/last frame buttons sit in Previz and submit no generation jobs. Unlinked first-frame video materializes a visible unlinked input image to preserve the existing slot-based FrameRef. A single explicit Generate click follows the existing user generation flow; batches retain their confirmation.
- Shot controls group choices by script, clear links with None, and allow several panels on one shot. Link in order previews changes and retains existing links unless replacement is selected. Script rows show linked panel thumbnails that locate and select their source. When no script exists, Ask the Agent adds a node reference and appends a draft to the current session composer without sending.
- Batches open from linked panels with script and media selectors. Composition inputs use blockout ?? image and have priority in the reference budget; estimates identify used references and dropped panels with unsupported/limit reasons. The planner also reports panel frames reused for first/last steps. Dry runs are read-only; confirmation materializes frame candidates idempotently and skips their replacement generation, including Agent batches at approval.
- The on-demand previz guide covers reading pictures and metadata, the single-message asking rules with defaults, layout rather than drawing-style prompts, picture permissions, and paid-step planning. The script and code-render guides point to it. It distinguishes render-only previz requests from explicit final-generation requests; no blockout instructions or new shot roles are added.
- Acceptance covers the previz-only editor, the needsKey-based Paid marker (using a local metadata-only fake provider that must never submit), free frame setup even with a blocked paid model, and the relocated model picker corner and relative-position guards. Tests use mock providers and fake Codex only. Step c retains blockouts, the previz shot role and three.js; page splitting, video references, tappable question cards, 100-panel performance measurements and real-model acceptance remain outside step b.

## Step c backend implementation notes (2026-11-04)

- `@vis/generation` pins `three` to `0.187.0`. Source and packaged render providers serve `/lib/three.module.js` and its relative import `/lib/three.core.js` alongside GSAP and Rough. These are daemon assets, with no three.js import in the web client.
- `packages/generation/src/providers/render/fixtures/blockout.html` is the reusable Windows test sample: ground, two capsules, a box, two `/input/<n>` textured planes and a camera move. It awaits both textures before defining `window.vis`, sets `preserveDrawingBuffer`, and renders only from `seek(t)`. Its real-provider regression runs for one second at 320×180 and 8 FPS, requires an active WebGL 2 context at every seek, checks all eight decoded frame hashes differ and probes the MP4 dimensions and frame count. Missing Chrome or ffmpeg skips as before; WebGL failure fails. The full Windows measurements in §7 remain deferred.
- `ShotLink.role` admits `previz`, while `ShotRole` remains `first | last | video`. Regression tests show a newer blockout cannot satisfy `currentShotNode`, alter frame/video batch plans, or enter `assembleScriptTimeline` as a finished video or first frame.
- New RPC `previz.extractBlockout`, available to UI and Agent callers, takes `{ requestId, slotId, expectedRevision, assetVersionId }` and returns `{ revision, frames: [{ panelId, atMs, assetVersionId }] }`. `slotId` identifies the previz main slot; `assetVersionId` identifies the blockout video. It rounds the sum of preceding panel durations to milliseconds for each extraction point. **Every panel must have a duration**, including the last; `previz.duration_required` names missing panel IDs. The total must match the freshly probed video duration within `1000 / fps` milliseconds, and every panel must start before the video ends; otherwise it returns `previz.duration_mismatch`. An unmeasurable duration or frame rate returns `previz.video_timing_required`, with no guessed default.
- When no panel has a duration, the UI asks the author before retrying with `fillDurations: true`, which splits the measured video length evenly in whole milliseconds and writes those durations with the frames. It is refused as `previz.duration_required` when only some panels lack durations. A panel without its own picture shows its blockout frame and can generate a composition from it; a frame panel still needs its own picture. Card messages float below the fixed-height node, and only the player and buttons block dragging.
- Frame extraction shares `asset.extractFrames` staging and transactional registration. That existing RPC adds optional `atMs` (1–200 explicit millisecond timestamps); it rejects combining `atMs` and `count`, and retains the default of six evenly spaced midpoint frames. Blockout writeback registers image assets and updates all `blockout` fields atomically, incrementing document/panel counters and the main slot revision while preserving drawings and all other metadata. Both the initial read and final write check `expectedRevision`; retries return the original result without another write. Agent writes require a live turn and linked unarchived work item, rechecked at writeback, and still pass `assertAgentPrevizWrites`. Tests cover preserved drawings, missing/mismatched timing, permissions, retry conflicts and a concurrent editor save that leaves no registered frames behind.
- The Render previz action, guides and script-row UI are implemented in the UI half of step c below. No real Agent or vendor API is used by these tests.


## Step c UI implementation notes (2026-11-04)

- Render previz in the card footer appends a node reference and localized request to the current session composer, retaining existing draft text and focusing the composer. It never sends or submits a job. The editor header flushes pending saves first and closes only when the draft controller reports a successful save; failure or conflict leaves the editor open with no added draft. Missing durations remain an Agent question, not a drafting gate.
- A completed video with the previz node in `inputs` is associated with the card; when it has a shot link its role must be `previz`. The newest matching node wins. The footer shows its cached poster and existing compact player with preview activation scoped to the player area, plus Use blockout frames. Unrelated videos and final-output shot roles are excluded.
- Extraction rereads the main slot and sends its current `expectedRevision`, rereading and retrying once after a conflict. Missing-duration errors identify the panel number and note. The tile still shows its original flattened image, with a small outlined blockout marker; the composition popover explains its source. Script rows show blockouts with a dashed border and an explicit previz-only label, without changing batch or timeline output selection.
- The on-demand previz guide adds grey-model purpose, free rendering only, one-message duration questions, code and panel asset inputs, local three.js imports, texture readiness, drawing-buffer preservation, seek-driven rendering, summed duration, 24+ fps, input/shot associations, extraction and picture protection. The code-render guide mentions three.js availability.
- Browser coverage uses fake Codex to read a previz and guide, write the reusable sample's HTML to a code node, submit a real local 24 fps render with panel asset inputs, link it and extract frames. UI cases cover draft/no-send and editor save ordering and failures, lazy playback and footer positions, named timing errors, a real revision conflict/retry preserving concurrent notes and drawings, distinct script-row markers and blockout composition in a mock batch. Screenshots are saved under `/tmp/vis-0029/step-c` at a 1600×1000 viewport and device scale factor 2.
- Remaining RFC gaps: real-Agent 3D quality evaluation and real-model sketch fidelity require maintainer approval; Windows WebGL measurements await a Windows machine (§7). Page splitting, the 100-panel performance measurement and video references remain deferred. No real Agent, paid provider, credential read or new dependency is used in the UI half.

## Real-Codex evaluation implementation notes (2026-11-04)

- The maintainer approved one Codex evaluation of V1–V6 with Mock and local render only. The runner completed all six scenarios, each with one user turn, using `codex-cli 0.166.0`. Sessions retained nullable model/effort configuration; their model catalogs resolved the default to `gpt-6.1-sol`, effort `low`. There were 60 translated tool calls and no tool errors. Agent jobs were two successful local renders, with no Mock or paid generation and no batches. V6's separate fixture render was created before its Agent turn. The private daemon exited normally.
- Harness fixtures contain four distinct 640×360 PNG panels, with separate underlay, sketch and flattened assets, Chinese notes, durations 2/1.5/2.5/2 seconds and script-shot links. V2 leaves panel durations 2 and 4 null while retaining script durations; V5 leaves panel links 2 and 4 null. V6 seeds the existing three.js regression sample as an eight-second, 24 FPS video linked through code/previz inputs and the `previz` shot role. Its sample scene is a render/extraction fixture, not an evaluation of story fidelity.

| Scenario | Recorded result | Turns / tool calls |
| --- | --- | --- |
| V1: make a blockout | Previz guide read; three.js render succeeded at 960×540, 8 seconds and 24 FPS; video retained code/previz inputs through `node.setInputs`. **Failed shot-role check:** video `shot` remained null. Five frames were extracted; native image viewing is not observable in the product transcript. The Agent also extracted panel blockouts without another user request. | 1 / 18 |
| V2: missing durations | Closing messages identified both missing panels and requested confirmation of script durations 1.5/2 seconds. No render, batch or other generation was submitted; both panel durations stayed null. Codex sent two closing messages, with repeated confirmation wording; one-message quality remains review. | 1 / 3 |
| V3: make a previz | Only local `render/html` was submitted; it succeeded at 1280×720, 8 seconds and 24 FPS. No Mock/paid job or batch occurred. This video also retained a null `shot`, an additional observation outside V3's isolation check. | 1 / 17 |
| V4: improve pictures | Every original underlay/sketch/image stayed unchanged. No write was attempted or refused, so this run did not exercise gateway rejection. The reply requested an image-editing provider because only Mock was configured. | 1 / 9 |
| V5: generate video | The first closing message asked whether to link panels 2/4 to shots 2/4 in order and use composition references, generating first frames for review before video; the second requested provider setup and said it would continue after confirmation. No batch or generation was submitted and links stayed null. Asking passes when both closing messages are inspected; defaults, repeated wording and one-message quality remain review. | 1 / 9 |
| V6: use blockout frames | `previz.extractBlockout` succeeded at 0/2000/3500/6000 ms; all four panel blockouts matched its returned asset IDs. Underlay/sketch/image and shot information were preserved. | 1 / 4 |

- The original runner scored V1/V2/V3/V5 `fail` and V4/V6 `review`. Harness false negatives were corrected with coordinator approval and unit coverage: the real MCP alias is `vis.guide`; an explicit Chinese confirmation request does not require a question mark; and asking must inspect all closing assistant text after the last tool call/result, rather than only the last summary. Offline rescoring of the same saved evidence gives V1 `fail`, V2–V6 `review`; original artifacts are retained. No real scenario was rerun. An initial detached shell launcher exited before runner initialization (empty log and no data/output directories); its one infrastructure-only relaunch started the six recorded turns.
- Visual quality remains `review`. The adapter omits native image-view items, so extracted frames and an Agent's inspection claim cannot prove visual inspection. V1/V3 shot-role omissions are guide-following findings: no rejected write prevented the required action. No product generation or extraction error occurred. The real run does not establish gateway enforcement against drawing writes, Windows rendering, paid-model fidelity or complete real-Agent acceptance.
- Validation: `pnpm build`, harness typecheck, 23 harness tests, and `pnpm check` passed (2,826 tests passed, 26 skipped). Two fake-Codex dry runs completed all six scenarios with expected semantic failures and no infrastructure errors. Product code, prompts and guides were unchanged. Raw artifacts are under `/tmp/vis-eval/out`, corrected scores under `/tmp/vis-eval/rescored`, and the detailed report at `/tmp/vis-eval/evaluation-report.md`. Videos and three frames each are under `/tmp/vis-eval/samples/V1`, `V3` and `V6`; V6 is the fixture video.

## Changes after the Codex evaluation (2026-11-04)

- A blockout often spans several shots, and a node holds one shot link, so V1 and V3 left it unset. The product now finds a shot's blockout through the panels linked to that shot and the blockout's inputs. Agents no longer set a shot link, and the `previz_shot_role` check became `previz_not_final_output`: a blockout must never hold a `first`, `last` or `video` role. An explicit `previz` role still displays.
- V1 extracted frames without being asked, which silently changes the picture later generation follows. The guide now says to offer extraction and run it only on request.
- These rules have not been rerun against real Codex. Reported separately: repeated closing messages in V2 and V5, and that the gateway refusal path was not triggered by a real Agent.

## Second real-Codex evaluation implementation notes (2026-11-05)

- The maintainer approved one invocation covering unchanged V1–V6 plus manuscript W1–W7, with Mock and local render only. It ran from `2026-11-05T01:57:58.155Z` to normal private-daemon exit at `02:07:00.638Z`, without an infrastructure retry or repeated scenario. The harness revision was `d2e08e33817ebd2745d4f50ccfa60863461f9220`, with a clean worktree at launch. Codex remained `codex-cli 0.166.0`; every session retained null model/effort overrides and catalog defaults `gpt-6.1-sol` / `low`.
- V1/V3 gained one hard check: zero attempted `previz.extractBlockout` calls without an explicit panel-writeback request. All other V prompts, fixtures and checks were retained from the post-evaluation rules above. The six previz scenarios used six turns, 63 translated tool calls and one tool error. Their only Agent generation jobs were two successful eight-second, 24 FPS local renders, both 1280×720; V6 used a separate fixture render. There were no Mock generation jobs, paid jobs or batches.

| Scenario | Original → corrected score | Observed result | Turns / tool calls |
| --- | --- | --- | --- |
| V1 | fail → fail | All render, timing, input and non-final-output checks passed, but the Agent again called `previz.extractBlockout` without a panel-writeback request and filled all four panel blockouts. Its first submit omitted `prompt` and was rejected; a corrected submit succeeded within the same turn. Frame extraction was observed; native frame viewing remains unobservable. | 1 / 19 |
| V2 | fail → fail | Both missing durations remained null and no generation occurred. The single closing message proposed script durations 1.5/2 seconds and said `确认后将…`, without an explicit question or request to confirm. The existing asking check therefore failed; wording quality remains review. | 1 / 9 |
| V3 | review → review | Render-only behavior, guide read and the new no-writeback check passed. The video retained code/previz inputs and a null shot link. | 1 / 16 |
| V4 | review → review | Original pictures stayed identical. No write was attempted, so the previz refusal path was still not exercised. The Agent requested an image-editing provider. | 1 / 8 |
| V5 | fail → review | No generation occurred and unlinked panels stayed null. Its first closing message explicitly offered two choices with `请选择下一步`; its second repeated the setup/association summary. The original asking failure was a harness false negative. | 1 / 7 |
| V6 | review → review | Extraction succeeded at 0/2000/3500/6000 ms; all four persisted blockouts matched the returned frame IDs, with original drawings preserved. | 1 / 4 |

- A regression now recognizes an explicit `请选择` choice request, while keeping conditional-only wording insufficient. V5 was rescored offline from the same saved evidence; the original failure is retained. W5 independently exposed a manuscript-tool alias mismatch, documented in RFC 0031. No product code, adapter prompt or guide was changed, and no real turn was rerun for either scoring fix.
- Compared with the first run, V1 still performs unrequested writeback despite the revised guide; V3 continues without writeback. Null video shot links now satisfy the revised non-final-output rule rather than the removed requirement to assign a single shot. V2 has one closing message instead of two, but loses the first run's explicit confirmation request. V5 again has two closing messages. These runs do not establish a deterministic repetition rate or visual acceptance.
- Videos and three decoded frames each are under `/tmp/vis-eval2/samples/V1`, `V3` and `V6` (fixture). Independent ffprobe output and exact frame indices are in `samples/manifest.json`. Raw evidence is under `/tmp/vis-eval2/out`, corrected scores under `/tmp/vis-eval2/rescored`, and the detailed report is `/tmp/vis-eval2/evaluation-report.md`. Visual fidelity, motion quality and native image inspection remain review; the observed failures concern guide-following/asking, not a render or extraction failure.

## Changes after the second Codex evaluation (2026-11-05)

- Guide wording did not stop V1 writing panel blockouts, so this is now a product rule: `previz.extractBlockout` is UI-only, and the gateway refuses Agent changes to `blockout` with `previz.blockout_user_only`. This supersedes the Agent caller in the step c notes. V6 now checks that frames are left to the user.
- The maintainer saw a crab walk in the V1 and V3 samples: both pages modelled the figure facing the camera and moved it along world X without turning it. The guide now states how to orient and walk a figure.
- The guide asks for a direct closing question, after V2 ended on "after you confirm".
- None of this has been rerun against real Codex.

## Render-submit guidance follow-up (2026-11-05)

The code-render guide now explicitly requires a nonempty `prompt` when submitting `provider: 'render'`, even when the HTML input supplies all frames. This addresses evaluation four's first rejected submit without changing generation validation or encoding creative taste. Guide delivery is covered by unit tests; no real Agent or vendor rerun was performed. Existing real-Agent and Windows acceptance gaps above remain open.
