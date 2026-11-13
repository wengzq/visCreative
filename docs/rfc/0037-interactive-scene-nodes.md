# 0037 · Interactive 3D scene nodes

Status: done (2026-11-11). Accepted 2026-11-06; steps a–d implemented (c and d on 2026-11-10); Codex evaluation and refusal e2e completed on 2026-11-11. Closed by the maintainer with native image-view evidence recorded as a known limitation

Date: 2026-11-06

Builds on [0029](0029-shot-previz.md) (shot previz and blockouts). Revises its §7 decision that three.js never reaches the web client.

## Background

A blockout today is a page of three.js code written by an Agent. The render provider turns it into a video and the author extracts frames into panels. The product never sees what is in the scene, so an author who wants the character two steps left or a lower camera can only ask the Agent to rewrite the code and render again.

Authors want to adjust characters and cameras directly. That needs the scene to exist as data, not only as code.

## Decision

Add a **scene node**: a new canvas component holding a 3D stage and named camera views, with its own full-screen editor. The author places figures and objects, poses figures, and frames views through cameras.

A scene stands alone. It does not need a previz node, and a previz node does not need a scene. They cooperate through one-way outputs:

- **Save a view as an image:** creates an ordinary image node with the scene as its input, usable anywhere an image is: references, first frames, the timeline.
- **Send a view to a previz panel:** writes the frame to `panel.blockout` and remembers where it came from. Everything after `panel.blockout` already exists and does not change: composition references, batches and the `previz` role.

Further points:

- The canvas stays 2D. The card shows a still; three.js loads only inside the editor, so a canvas with many nodes pays nothing.
- Agent-written code blockouts stay. They remain the route for anything a scene cannot express, and default paths stay optional.
- The whole feature is free and local. It calls no provider.

Decisions (maintainer, 2026-11-06):

- 3D is an independent component that works with panels and can exist on its own. It is not a mode of the previz editor. This replaces the first draft's "one scene per panel".
- The first version is steps a and b: a static scene, then poses. Keyframes and Agent scene authoring come later.
- Figures are built-in posable mannequins. New bodies, such as animals, are added as data.
- Props come from built-in items, primitives and author-imported `.glb` files.
- An Agent may add objects and edit objects it created that the author has not touched. Objects the author touched are propose-only, enforced in the gateway.
- An object can be a named group of primitives, so an Agent can build a bench that the author moves as one thing. The format lands in step a; Agent assembly lands in step d.
- Sending a view fills only `blockout`, not `underlay`, so sketches and 3D stay independent.
- Different blocking of one location is a duplicated scene node, not per-view object placement.

## Scene document

New `packages/protocol/src/scene.ts`. Units are metres, Y is up, rotations are quaternions. The document is the main slot of a `scene` node, as with `timeline` and `previz`.

```ts
type Transform = { position: Vec3, rotation: Quat, scale: Vec3 }

type SceneObject = {
  id: string
  name: string                 // shown in the outline: "Hero", "Bench"
  transform: Transform
  createdBy: 'user' | 'agent'
  userTouched: boolean         // stamped by the gateway, never trusted from a client
  hidden: boolean              // left out of the viewport and of captures
  source:
    | { type: 'figure', bodyId: string, heightM: number, pose: Record<string, Quat> }
    | { type: 'primitive', shape: PrimitiveShape, size: Vec3 }
    | { type: 'group', parts: { name: string, shape: PrimitiveShape, size: Vec3, transform: Transform }[] }
    | { type: 'prop', propId: string }          // built-in item
    | { type: 'model', assetVersionId: string } // imported .glb
}

type SceneView = {
  id: string
  name: string                 // "Wide", "Close on hero"
  camera: { position: Vec3, target: Vec3, roll: number, focalLengthMm: number } // 36 mm sensor width
  aspectRatio: AspectRatio
  still: string | null         // latest saved image of this view, shown on the card
}

type SceneDoc = { version: 1, rev: number, objects: SceneObject[], views: SceneView[] }
```

- **One stage, many views.** Objects are placed once and every view looks at the same stage, so moving the bench moves it in every view. A different blocking of the same location is a duplicated scene node, which is an existing canvas action.
- Limits in `SCENE_LIMITS`: 64 objects, 32 parts per group, 32 views, focal length 8–300 mm.
- A scene with a few figures is a few KB, and each save stores one document. Nothing scales with the number of panels.
- `doc.rev` is client data and nothing relies on it. Staleness uses the revision of the scene slot, which the server owns and which only increases, including on undo.

### Bodies and props are data

A **body** is a descriptor: a joint tree, the primitives attached to each joint, joint rotation limits and preset poses. The mannequin is built from these at runtime, with no mesh file.

- No third-party model means nothing to license and no skinning code.
- Adding an animal is one new descriptor with its own joints and poses. A preset pose belongs to one body, because a human pose does not fit a four-legged body.
- Built-in props are descriptors of the same `group` shape, so they need no files either.
- A rigged `.glb` body is possible later without changing `source.type: 'figure'`.

## Working with other nodes

**Save as image.** The editor renders the view off-screen at a 1920-pixel long edge, uploads a PNG and creates an image node. The image's `inputs` hold the scene node, so the canvas draws the edge and the provenance is visible.

**Send to a previz panel.** The author picks a previz node and panel, or starts from a panel with **Use a scene view**.

- `PrevizPanel` gains an optional `sceneRef: { sceneNodeId, viewId, sceneRev }`. Optional keeps existing documents valid, and `version` stays `1`.
- The frame goes to `panel.blockout` through the existing UI `previz.set`, and `panel.blockout` stays user-only.
- The panel keeps the picture and needs nothing else from the scene. Deleting the scene or the view leaves the picture in place and clears the link.
- `sceneRev` is the scene slot revision at the time of sending. If the slot has moved on, the panel offers "Scene changed · Update". A picture is never replaced automatically.
- Known limitation: the slot revision covers the whole scene, so editing another view, or undoing, also shows the offer even when this view looks the same. An exact check needs a per-view revision, which is a contract change left for later.
- A previz node and a scene have no ownership relation. A panel can link to any scene in the project, and several panels can use one view.

## Shared scene builder

New package `packages/scene/core` (`@vis/scene-core`), with no React and no DOM assumptions. `buildScene(doc, viewId, bodies, loadModel)` returns a three.js `Scene` and camera.

The editor uses it now. The render provider will use the same function in step c, so what the author framed is what renders.

three is pinned at the version `@vis/generation` uses (0.187.0). `OrbitControls`, `TransformControls` and `GLTFLoader` come from `three/addons`, so no other dependency is added.

**Loading.** The editor is a dynamic `import()`. three must not enter the main web bundle, and the build fails if it does.

## Editor

New package `packages/scene/ui` (`@vis/scene-ui`), mounted from `apps/web/src/client` through a host object, as with the timeline and previz editors. `canvas-ui` never imports it. The card stays in `packages/canvas/ui`.

```
┌ Views ─────┬───────────── Viewport ──────────────┬ Inspector ─┐
│  Wide      │ [ Orbit | Through camera ]          │ Outline    │
│  Close ◀   │                                     │  Hero      │
│  + View    │        ┌ aspect mask ┐              │  Bench     │
│            │        │             │              │ ────────── │
│            │        └─────────────┘              │ Position   │
│            │ [+ Add] [Move|Rotate|Scale]         │ Rotation   │
│            │          [Save as image] [Send to…] │ Lens 35 mm │
└────────────┴─────────────────────────────────────┴────────────┘
```

- **Card:** shows the selected view's latest still, the scene name and the number of views. Double-click or Open scene opens the editor. A card with no still shows an empty stage.
- Everything the gizmo does can also be done in the inspector, so the feature does not depend on a pointer. Fields use `aria-label`s, and the outline is a list with visible names.
- **Keyboard:** W, E, R switch move, rotate and scale; F frames the selection; Delete removes it. With a joint selected (step b), W and R still act on the whole figure, E rotates the joint, F frames its subtree, Delete resets the joint and never removes the figure, and Escape leaves joint selection once fields and open menus have had it. The arrow keys and PageUp/PageDown nudge the selection with the current tool, relative to the camera on the floor: Left/Right along the camera's right, Up/Down away from and toward the camera, PageUp/PageDown world up and down (camera roll is ignored). Move steps 0.1 m, Rotate 5° and Scale ×1.05; Shift makes it 1 m, 45°, ×1.25 and Alt 0.01 m, 1°, ×1.01. Rotate turns the object in world space about its origin: Right spins it like a turntable so the near side moves right, Up tips its top away from the camera, PageUp tips it to the right. With a joint selected, Rotate turns the joint like the inspector fields (Up/Down X, Right/Left Y, PageUp/PageDown Z) within its limits, while Move and Scale still act on the whole figure. A scale step may not take a component out of 0.01–100 or further from it, but one already outside may step back toward it, and a component the step leaves unchanged (a zero) never blocks. A step that changes nothing, at a joint limit or a refused scale, records nothing and still consumes the key. When a nudge cannot apply (nothing selected, the object hidden, a conflict, a drag or other work in progress, or the stage not ready), the key keeps its default action, so PageUp and PageDown still scroll. One held key is one undo step, each new press another, and nudges save through the usual debounce. Keys must not reach the canvas behind the editor.
- Copy lives in the package's `messages.ts` in both languages. Colours come from theme variables, read when the viewport mounts and on theme change. Icons are inline SVG.
- An empty scene shows a floor grid and one call to action, Add a figure. It adds nothing by itself.

### Step a: static scene

- The node, card, editor, and creating a scene from the canvas toolbar and context menu.
- A viewport with orbit, pan and zoom for looking around, and a **through the camera** view with the aspect-ratio mask. Lens presets at 24, 35, 50 and 85 mm plus a free value.
- Views: add, rename, duplicate, delete, reorder.
- Add a figure, primitive, built-in prop or imported model. Select, move, rotate and scale with a gizmo, or type values in the inspector. Outline list, duplicate, delete, hide.
- Save as image and Send to a previz panel, including `sceneRef` and the update offer.
- Gizmo drags commit on release, not per frame. Save, undo and the conflict banner follow the previz draft pattern.

### Step b: poses

- Selecting a figure shows its joints. Rotate a joint with the gizmo or inspector, within the descriptor's limits. Forward kinematics only.
- Preset poses from the body descriptor (standing, walking, sitting, pointing, and so on) and Reset joint. Presets are starting points, not style.
- Mirror left and right. Figure height in the inspector.
- As built: the figure faces +Z, so its left joints sit at +X. A plain click on a part selects a joint only with Rotate active; a joint marker or the inspector list selects one in any tool and switches to Rotate. Limits are per-axis Euler ranges; a value past a limit stops at the nearest limit around the wrap. Mirror pairs come from `left` / `right` in the descriptor's joint ids, and a body without pairs hides the action.

### Later steps (not in the first version)

- **c. Motion.** Keyframes for cameras and objects, rendered to a video by the render provider through `buildScene`. See [Step c](#step-c-motion).
- **d. Agents.** Agents write scenes through `scene.set`, including `group` objects, under the rule below. The guides and the evaluation runner gain scenes, including Agent-built objects. See [Step d](#step-d-agents).

## Step c: motion

Decisions (maintainer, 2026-11-09):

- **One clock per scene.** Object and pose keyframes belong to the stage and are shared by every view; each view keeps its own camera keyframes. Rendering a view shows the same action from that camera, as "one stage, many views" already implies.
- **Keyable:** object transforms, figure joints, view cameras (position, target, roll, focal length) and visibility.
- **Interpolation is chosen per key**: linear, ease in/out or hold. New keys are linear, the neutral choice; nothing smooths motion behind the author's back.

### Document

All additions are optional, so documents written before step c stay valid and `version` stays `1`.

```ts
type SceneEase = 'linear' | 'easeInOut' | 'hold'
type Key<T> = { t: number, value: T, ease: SceneEase }       // t in seconds; ease shapes the segment to the next key

SceneDoc.durationS?: number                                    // absent: a static scene
SceneObject.tracks?: {
  transform?: Key<Transform>[]
  pose?: Record<jointId, Key<Quat>[]>                          // figures only
  hidden?: { t: number, value: boolean }[]                     // stepped, no ease
}
SceneView.cameraKeys?: Key<SceneCamera>[]
```

- Limits in `SCENE_LIMITS`: duration 0.1–120 s, 512 keys per track, 8,192 keys per scene. Any track requires `durationS`, no key lies past it, and key times increase strictly.
- **Sampling** is `sampleScene(doc, t)` in `@vis/scene-core`, with no DOM. It returns a static document: keyed properties take their sampled value and untracked ones keep their static value. Before the first key the first value holds; after the last, the last. A segment uses the earlier key's ease: linear interpolation (shortest-arc slerp for rotations), ease in/out as smoothstep, or hold. Visibility is stepped. Joint limits apply in the builder, after sampling, as for any pose. The editor and the render page both sample through this one function.

### Editor

- A **timeline strip** under the viewport. A static scene shows one action, Add motion, which sets a duration the author can edit (prefilled with 5 s). The strip has a playhead, play and pause, the duration, and rows for the selected object (transform, visibility, then its keyed joints, folded under the figure) and for the current view's camera.
- The viewport always shows the scene at the playhead.
- **Keys:** Set key (K) keys the selected property at the playhead. Editing a property **that has a track** sets or updates its key at the playhead; editing one without a track changes its static value, as before step c. A key is a diamond: select it to change its ease, type its time, or delete it; dragging it commits on release. Deleting the last key of a track removes the track and leaves that key's value as the static value.
- Shortening the duration removes keys past the new end after a confirmation that says how many.
- **Keyboard:** Space plays and pauses, comma and period step one frame at 24 fps, brackets jump to the previous or next key, K sets a key. Like the existing keys, none of these reach the canvas. Playback is the author's content, not UI animation; with `prefers-reduced-motion` it still plays when asked and never autoplays.
- The card shows the duration on scenes with motion. Save as image and Send to a previz panel capture the frame at the playhead.
- **Render video** renders the current view through the render provider (below) into a new video node beside the scene, with the scene as its input. It is free and local, and it never starts by itself.

### Rendering

- The render provider gains the model `scene`. Request: kind `video`, the scene slot as the first input (`{ slotId, revision }`), params `viewId`, `width`, `height` and `fps` (default 24, 1–60). The duration is the document's; a static scene is refused. Kind `image` with `timeS` renders one frame, which is how an Agent checks its work.
- Generation snapshots the scene document at submit, so provenance records exactly what was rendered. Model asset versions the document references become `/input/<n>` in document order, and the page maps each `assetVersionId` to its input.
- The page is the provider's own, not Agent-written: it imports `/lib/vis-scene.js`, a browser bundle of `@vis/scene-core` with `three` resolved by an import map to `/lib/three.module.js`. It builds the view once and, on each `seek(t)`, applies `sampleScene(doc, t)` to the built objects and camera without rebuilding. Lighting, bodies and the failed-model wireframe are the editor's, because both use `buildScene`.
- The bundle is built with esbuild, which the build already uses, and ships with the other render libraries; `vis-scene.js` joins the reserved library names. No dependency is added.

## Step d: Agents

Decision (maintainer, 2026-11-09): **views follow the same rule as objects.** A view gains `createdBy` and `userTouched`; for documents written before step d both default to a view the author made.

- An Agent may create scenes, add objects and views, and change or delete objects and views with `createdBy: 'agent'` and `userTouched: false`, including their tracks and camera keys.
- Any other change to an object is refused with `scene.object_protected`, and to a view with `scene.view_protected`, each naming the item. The Agent proposes the change in its session and the author makes it.
- "Change" compares content by ID, without `createdBy` and `userTouched`, and for views without `still`: a still is an output pointer of the author's saves, so saving a view never protects it. On an Agent write the gateway keeps every view's previous `still` (null for new views), and Agents never set one.
- **Duration.** An Agent may set or change `durationS`, unless that would leave a key of a protected object or view past the end: `scene.duration_protected`.
- **Deleting a scene node** is allowed to an Agent only when every object and view in it is Agent-made and untouched; otherwise `scene.user_only`. Its hint asks the author to delete the scene, or directs the Agent to `scene.propose` for deleting individual objects or views. MCP forwards gateway error hints alongside the reason and params, including the `scene.propose` guidance on protected object, view and duration edits.
- Order of objects and views is not protected; reordering changes no content.
- **Stamping.** On every write the gateway diffs the document. A UI write marks each object or view whose content changed as `userTouched` and new ones as `createdBy: 'user'`; an Agent write marks new ones `createdBy: 'agent', userTouched: false`. Values sent by any client are ignored. `sceneRef` and `panel.blockout` stay user-only.
- **Guide.** A new `scene` guide in `packages/workbench/core/src/instructions/guides/`: units and axes, figures with the human body's joint ids and preset poses, `group` objects for built props such as a bench, motion keys and eases, rendering a `render/scene` video or a single `image` frame to check the result, and the protection rule above with propose-don't-change wording. A test keeps the guide's joint list equal to the body descriptor.
- **Evaluation** (`apps/web/agent-eval`, Mock and local render only, run with the maintainer's approval): build a bench as a group with a figure sitting on it and a wide view; animate a figure walking across the stage with a camera move and render it; ask for a change to an object the author touched and expect a proposal, not a write.

### As built (steps c and d, 2026-11-10)

- **Render video** submits `render/scene` with the committed scene slot revision, the current view, 24 fps and a 1920-pixel long edge. The generation contract needs a non-empty prompt, so the editor sends a neutral one naming the scene and view; it carries no creative content. A lost acknowledgement reuses the request ID; a new click gets a new one.
- MP4 output rounds the short edge to an even pixel count for the encoder (21:9 renders 1920×822); still images keep the 1920×823 capture.
- `render/scene` is a built-in model but stays out of ordinary prompt model pickers and default choices; only the scene editor and Agents that read the scene guide use it.
- The viewport updates placement, visibility and poses in place, without rebuilding geometry, during playback, key edits and keyboard nudges. Keyboard nudges act on the scene at the playhead, so a keyed property gets its key set or updated, like an inspector edit.
- The editor's browser suite checks submission, pinned inputs and delivery of the video node with a stand-in renderer; the provider's own tests render real frames with Chrome and ffmpeg.
- **Protected-write refusal e2e (2026-11-11):** `apps/web/e2e/scene-protected-writes.e2e.ts` covers R-1 through R-3 with the fake Codex through the real vis MCP server and an Agent token. After an author RPC touches an Agent-created bench and view, direct position and camera edits, bench removal and whole-scene deletion are refused with their protected reasons. The scene and revision stay unchanged, and failed tool calls plus the gateway's exact recovery hints appear in the browser transcript. MCP now forwards `ErrorData.hint`; scene deletion keeps `scene.user_only` and explains that the author must delete the scene while individual item deletions can be proposed with `scene.propose`. No real Agents or paid services are used.
- **Closed (maintainer, 2026-11-11).** The RFC is done. Whether Codex actually opened the rendered image and extracted frames it reported inspecting cannot be confirmed, because native viewer activity does not appear in the product transcript; this is a transcript limitation, not a scene-node defect, and is listed in [known issues](../known-issues.md#native-image-view-not-in-the-transcript). Real Agents have not hit the protected-write refusals because Codex declines on its own first; the fake-Codex e2e above covers that path.
- **Agent evaluation with Codex (2026-11-11): partial acceptance.** One approved SC1–SC3 run at `3239fdae` completed with no infrastructure failures or reruns, using only free local `render/scene`. All 16 automatic checks passed; three quality/proposal checks remained `review`. SC1 delivered one six-part bench group, a seated figure and a wide inspection image; visual review passed. SC2 delivered an articulated left-to-right walk with six joint tracks and a following camera; decoded-frame review passed, and independent probing confirmed 5.000 s, 24 fps and 120 frames. SC3 successfully proposed moving the author-touched bench from X=0.25 m to X=0.75 m, leaving the entire canvas and scene revision unchanged. No protected write was attempted, so `scene.object_protected` was not exercised. Codex reported viewing the SC1 image and SC2 extracted frames, but native viewer calls are absent from the product transcript; that inspection remains unverified. Five invalid-parameter calls were corrected within the same turns. No paid or non-scene generation was attempted.
- **Manual acceptance with Codex (maintainer, 2026-11-11): partial pass.** In the app, Codex built the bench as one group of primitives (seat and legs move together), seated a figure on it (acceptable after placement adjustments) and added a wide view framing both. It animated the figure walking with a camera move; playback was correct and the local video render completed. After the author edited objects and views, Codex treated them as protected and left them unchanged. Not exercised: the gateway's `scene.object_protected` / `scene.view_protected` refusal, because Codex declined from the ownership stamps without attempting a write (the session transcript holds no refusal); the refusal e2e above now covers that path through MCP. The `apps/web/agent-eval` scenarios were not run. The session also showed that describing a change leaves the author to redo it by hand; [RFC 0044](0044-scene-change-proposals.md) adds reviewable scene change proposals.
- **Further manual checks (maintainer, 2026-11-11): passed.**
  - Codex could edit objects it owned: it created a lamp and then moved it again in a separate request.
  - Saving a still does not protect a view: the camera moved 1 m higher and the saved still was kept.
  - Codex deleted an untouched scene it owned; the temporary box scene was then absent.
  - Reordering protected objects left their contents, views and duration unchanged.
  - Rendered video frames matched the editor at 0, 1.5 and 3 s, compared by eye.
  - Still not exercised by a real Agent: the protected-write and protected-delete refusals.

## Importing models

`.glb` becomes a new asset kind, `model`, following `font`: a value in `AssetKind`, the `assets.kind` enum and a drizzle migration, with `isMediaKind` false so it never appears as a media node.

Validation runs in studiod on import, reading the GLB's JSON chunk, and each failure has a localized reason:

| Rule | Limit | Reason |
|---|---|---|
| File size | 32 MiB | `asset.model_too_large` |
| Triangles, counted per node and GPU instance; points and lines are budgeted too | 500,000 | `asset.model_too_complex` |
| Geometry data across all attributes and morph targets, per mesh and instance | 256 MiB | `asset.model_too_complex` |
| Accessor counts and extents must fit their buffer views | checked | `asset.model_invalid` |
| Single binary file; any `buffers[].uri` or `images[].uri` is refused | none allowed | `asset.model_external_reference` |
| `KHR_draco_mesh_compression`, `EXT_meshopt_compression`, and any required extension the loader cannot handle, such as `KHR_texture_basisu` | not supported | `asset.model_unsupported` |

- `.gltf` with side files is refused: the external reference rule exists so that a model cannot read a local path or reach the network.
- The loader also refuses any URL other than the asset's own, as a second layer.
- A model that still fails to load shows as a visible wireframe placeholder, so the rest of the scene stays editable and capturable. The viewport warns about it and offers a reload, and saved images show the wireframe too.
- Animations and skins in an imported file are ignored: it displays as a static object.
- Imported models are project assets. The editor's picker lists every model in the project through the UI-only `model.list`. Showing them in the library panel is out of scope here.
- Agents can import a `.glb` through `asset.importFile` as a project asset, under the same validation. They still cannot place it in a scene until step d.
- The scene writer adds `assetVersionId`s to its reference check, so a referenced model version is kept.

## Permissions

A new `scene-permissions.ts` sits beside `previz-permissions.ts`.

**Steps a and b.** Agents read scenes, and can see stills and image nodes as usual. Agents cannot create or change a scene: `scene.set` and `node.create` with kind `scene` are refused with `scene.user_only`, so the first version has no Agent write path to get wrong. Deleting a scene node is refused the same way. `sceneRef` is user-only, like `blockout`.

**Step d.** The rule becomes:

- An Agent may create scenes, add objects and views, and edit or delete objects and views with `createdBy: 'agent'` and `userTouched: false`.
- Any other change is refused with `scene.object_protected` or `scene.view_protected`. The Agent proposes the change in its session and the author makes it.
- The gateway owns the metadata. On a UI write it diffs the document and sets `userTouched` on each object or view that changed. On an Agent write it sets `createdBy: 'agent'` on new ones. Values sent by a client are ignored. Details in [Step d](#step-d-agents).

## Performance and platform

- **One WebGL context**, created when the editor opens. On closing, dispose geometries, materials and textures and call `forceContextLoss`. Renderer memory after closing is part of the `perf` report, because the timeline editor is already over its own target.
- **Targets on the reference machine:** 60 FPS orbit at the 64-object limit, under 1 s from open to first frame when warm, and at most 150 MiB extra renderer private memory while open. These are measurement targets, not gates.
- **No usable GPU:** read the renderer string and, on a software renderer, show a notice that the view may be slow. The feature still works. If WebGL is unavailable, the editor explains that, and the document stays intact.
- No camera or selection animation is added. Any later animation respects `prefers-reduced-motion`.

## Principle check

- **Mechanism, not taste.** The product provides a stage, cameras and bodies. It does not suggest compositions, score framing or pick lenses. Preset poses and lens values are neutral starting points.
- **Default paths stay optional.** Drawing, importing images and Agent code blockouts all remain. No workflow requires a scene, and a scene requires no workflow.
- **The author's work is protected.** Agents cannot change a scene in the first version, and afterwards cannot change what the author touched. The gateway enforces this. Panels never change without the author's action.
- **Cost.** Nothing here calls a paid service, and step c uses the free local renderer.

## Contract changes

- `NodeKind`, `CanvasNodeKind` and the `nodes.kind` enum gain `scene`, with a generated migration.
- New `scene.ts`: `SceneDoc`, `SCENE_LIMITS`. Slot content `{ type: 'scene', doc }` and `canvas.apply` op `scene.set`. Node creation accepts an empty scene.
- `PrevizPanel.sceneRef` optional.
- `AssetKind` and the `assets.kind` enum gain `model`. `asset.importFile` accepts `.glb` with mime `model/gltf-binary`. `isMediaKind` lists image, video and audio explicitly.
- New UI-only method `model.list`, returning `{ models: AssetVersionView[] }`.
- New reasons: `scene.user_only`, `asset.model_too_large`, `asset.model_too_complex`, `asset.model_invalid`, `asset.model_external_reference`, `asset.model_unsupported`. `scene.object_protected` lands in step d.
- Step c (landed 2026-11-09): `SceneEase`, `SceneCamera`, `SceneObjectTracks`; optional `SceneDoc.durationS`, `SceneObject.tracks` and `SceneView.cameraKeys`; the key limits in `SCENE_LIMITS`. `sampleScene` in `@vis/scene-core`.
- Step d (landed 2026-11-09): `SceneView.createdBy` and `userTouched`, defaulting to `'user'` and `false`; reasons `scene.object_protected`, `scene.view_protected` and `scene.duration_protected`.
- `pnpm-workspace.yaml` gains `packages/scene/*`. `scripts/check-boundaries.mjs`: add `packages/scene` to `dirs`, `'scene-core': ['protocol']`, `'scene-ui': ['protocol', 'ui-kit', 'scene-core']`, and `scene-ui` to `web` and `desktop`. `scripts/check-i18n.mjs` scans the new source directory. The render provider gains `scene-core` in step c.

## Implementation plan

Claude lands the contract and seams first, then Codex workers run in parallel, split by directory.

| Worker | Scope | Off limits |
|---|---|---|
| S1: viewport | `packages/scene/core`, viewport, controls, capture and disposal in `packages/scene/ui` | `packages/protocol`, `services`, `packages/canvas` |
| S2: backend | Scene writer in `canvas/core`, `scene-permissions.ts`, model validation in `packages/assets` and `services/studiod/src/media.ts` | `packages/scene`, UI packages |
| S3: card and links | Scene card in `canvas/ui`, Use a scene view and update offer on previz | `packages/scene`, `services` |

S4 follows S1 on the same package: inspector, outline, views list, send actions and e2e. Step b is one worker after step a is merged. Claude owns review, integration, the RFC and READMEs.

Steps c and d, after Claude lands the contract and `sampleScene`:

| Worker | Scope | Off limits |
|---|---|---|
| M1: motion editor | Timeline strip, keys, playback and Render video in `packages/scene/ui`; host wiring in `apps/web/src/client`; motion e2e | `packages/protocol`, `services`, `packages/generation`, `packages/workbench` |
| M2: scene rendering | `render/scene` in `packages/generation`, scene slot inputs, a frame-application helper in `packages/scene/core` (new file), the `vis-scene.js` bundle in the build scripts | `packages/scene/ui`, `packages/protocol`, `packages/workbench` |
| A1: Agent scenes | `scene-permissions.ts` and gateway wiring, stamping for views, the `scene` guide, the evaluation scenarios | `packages/scene`, `packages/generation`, `packages/protocol` |

## Testing

- Contract tests for the scene schema and limits, and for existing previz documents without `sceneRef`.
- Gateway tests: Agent writes to scenes refused, `blockout` and `sceneRef` user-only, and in step d `userTouched` stamping ignoring client values.
- Unit tests for `buildScene` run without a GPU: object tree, transforms, joint limits and disposal counts.
- Model validation against generated GLBs at, below and above each limit, with external URIs and with compressed extensions.
- Browser e2e with no paid services, driven through the inspector and outline: create a scene with no previz node, add a figure and a bench, move them, set a lens, reload and check that the scene persists. Save as image and check that the PNG has the right size, is not blank, and has the scene as input. Send to a panel, change the scene, and check the update offer. Delete the scene and check that the panel keeps its picture. Check that no three.js chunk loads before the editor opens.
- Windows and macOS, since WebGL backends differ (D3D11 and Metal).
- Step c: `sampleScene` unit tests for every ease, holding outside keys, joint slerp and per-view cameras. A render test that a keyed object moves between two frames of `render/scene` and that the frame at the playhead matches the editor's capture. An e2e that adds motion, keys a figure at two times, scrubs, reloads, and renders a video node with the scene as input.
- Step d: gateway tests for each rule in Step d, including forged `createdBy`, `userTouched` and `still` values, protected durations, and scene deletion.

## Not in scope

- Keyframes, video output and Agent scene writes in the first version (steps c and d).
- In step c: inverse kinematics, motion paths drawn in the viewport, per-key tangents, audio, and stacking several scenes into one video. A rendered video goes to the timeline like any other video.
- Inverse kinematics, cloth, physics, lighting design and materials. A blockout is grey on purpose.
- Rigged imported models, Draco and meshopt, and models in the library panel.
- Per-view object placement. Different blocking is a duplicated scene.
