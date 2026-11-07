# 0037 · Interactive 3D scene nodes

Status: accepted (2026-11-06); steps a and b implemented, steps c and d not yet

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
- **Keyboard:** W, E, R switch move, rotate and scale; F frames the selection; Delete removes it. With a joint selected (step b), W and R still act on the whole figure, E rotates the joint, F frames its subtree, Delete resets the joint and never removes the figure, and Escape leaves joint selection once fields and open menus have had it. Keys must not reach the canvas behind the editor.
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

- **c. Motion.** Keyframes for cameras and objects, rendered to a video by the render provider through `buildScene`.
- **d. Agents.** Agents write scenes through `scene.set`, including `group` objects, under the rule below. The guides and the evaluation runner gain scenes, including Agent-built objects.

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

- An Agent may create scenes, add objects, and edit or delete objects with `createdBy: 'agent'` and `userTouched: false`.
- Any other change is refused with `scene.object_protected`. The Agent proposes the change in its session and the author makes it.
- The gateway owns the metadata. On a UI write it diffs the document and sets `userTouched` on each object that changed. On an Agent write it sets `createdBy: 'agent'` on new objects. Values sent by a client are ignored.

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
- `pnpm-workspace.yaml` gains `packages/scene/*`. `scripts/check-boundaries.mjs`: add `packages/scene` to `dirs`, `'scene-core': ['protocol']`, `'scene-ui': ['protocol', 'ui-kit', 'scene-core']`, and `scene-ui` to `web` and `desktop`. `scripts/check-i18n.mjs` scans the new source directory. The render provider gains `scene-core` in step c.

## Implementation plan

Claude lands the contract and seams first, then Codex workers run in parallel, split by directory.

| Worker | Scope | Off limits |
|---|---|---|
| S1: viewport | `packages/scene/core`, viewport, controls, capture and disposal in `packages/scene/ui` | `packages/protocol`, `services`, `packages/canvas` |
| S2: backend | Scene writer in `canvas/core`, `scene-permissions.ts`, model validation in `packages/assets` and `services/studiod/src/media.ts` | `packages/scene`, UI packages |
| S3: card and links | Scene card in `canvas/ui`, Use a scene view and update offer on previz | `packages/scene`, `services` |

S4 follows S1 on the same package: inspector, outline, views list, send actions and e2e. Step b is one worker after step a is merged. Claude owns review, integration, the RFC and READMEs.

## Testing

- Contract tests for the scene schema and limits, and for existing previz documents without `sceneRef`.
- Gateway tests: Agent writes to scenes refused, `blockout` and `sceneRef` user-only, and in step d `userTouched` stamping ignoring client values.
- Unit tests for `buildScene` run without a GPU: object tree, transforms, joint limits and disposal counts.
- Model validation against generated GLBs at, below and above each limit, with external URIs and with compressed extensions.
- Browser e2e with no paid services, driven through the inspector and outline: create a scene with no previz node, add a figure and a bench, move them, set a lens, reload and check that the scene persists. Save as image and check that the PNG has the right size, is not blank, and has the scene as input. Send to a panel, change the scene, and check the update offer. Delete the scene and check that the panel keeps its picture. Check that no three.js chunk loads before the editor opens.
- Windows and macOS, since WebGL backends differ (D3D11 and Metal).

## Not in scope

- Keyframes, video output and Agent scene writes in the first version (steps c and d).
- Inverse kinematics, cloth, physics, lighting design and materials. A blockout is grey on purpose.
- Rigged imported models, Draco and meshopt, and models in the library panel.
- Per-view object placement. Different blocking is a duplicated scene.
