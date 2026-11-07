# Scene editor

The web host mounts `SceneEditor({ host })` through a dynamic import. Keep `scene.css` in the editor's stylesheet path. `SceneEditorHost` remains the boundary to uploads, model assets and document commits; the viewport never calls RPC directly.

`SceneEditor` composes `useSceneDraft(host)`, `createSceneViewportController(host)` (memoized per node), `useSceneViewportState(controller)` and `SceneViewport`. The layout is Views, Viewport with its toolbars, and Inspector. Views can be captured from the current camera, renamed, duplicated, reordered and deleted. The inspector provides an outline, object visibility and duplication, transforms in metres and degrees, figure height, and lens presets or a free focal length. Object and view limits are displayed when reached.

Add opens a keyboard-accessible picker for mannequins, primitives, built-in props, GLB import and existing project models from `host.listModels()`. W, E, R, F and Delete stay within the editor and leave text fields alone. Escape dismisses the active picker, dialog or field first. The viewport and draft retain their unavailable-renderer, software-renderer, save and conflict states.

The controller stores only local selection, tool, view and navigation state:

- `select(id)`, `setTool('translate' | 'rotate' | 'scale')`, `setView(id)` and `setMode('orbit' | 'camera')` update local state.
- `frameSelection()` frames the selected object in the orbit view without editing the scene.
- `readCamera()` returns the current position, target, roll and focal length. A views list can use it to explicitly create or update a view.
- `captureView(viewId)` renders the current stage through that named view to a PNG `Blob` with a 1920-pixel long edge, using the existing WebGL context. It excludes the grid and gizmo. The caller chooses whether to upload, save an image or send to a panel.
- `getSnapshot()` and `subscribe()` support external UI; the React hook supplies the same stable snapshot.

The snapshot includes `selectedId`, `tool`, `viewId`, `mode`, `dragging`, `status`, `softwareRenderer` and `error`. Disable edits during conflicts and drags. An optional `host.initialViewId` opens in camera mode, falling back to the first view when missing. `initialTarget` is exposed in the snapshot for the send action's initial panel selection; no action sends a frame automatically.

`SceneViewport` receives the draft document, the controller, `assetUrl`, `disabled`, and callbacks `onBeginEdit`, `onTransform(id, transform)` and `onCameraChange(viewId, camera)`. Feed transform/camera results into `draft.edit(nextDoc, true)`: these fire on gesture release only. Inspector fields can call `draft.edit(nextDoc)` for debounced autosave. `draft.undo()`, `flush()`, `conflict` and `loadTheirs()` follow the previz draft pattern. Keep the controller stable across document/host updates so one mounted viewport owns one renderer.

Save as image and Send to both use `captureSceneStill`: flush the draft, capture the view, upload a PNG, write `view.still`, then flush that write. Async actions read `draft.getSnapshot()` to get the latest `baseRevision` as `source.sceneRev`: this is the server-owned main slot revision. `doc.rev` is client data and must not be used to detect a changed scene. A concurrent writer during capture produces a conflict and leaves the panel untouched.

Send to lists previz nodes and panels from `host.nodes`. It preselects `host.initialTarget` without writing; only Send calls `host.sendToPanel`. Save as image calls `host.saveImage` after the still is committed. Both remain explicit author actions.

Built-in descriptor IDs are `human` and `bench`, `chair`, `table`, `wall`, `door`, `car`. Descriptors and the renderer-independent builder are exported by `@vis/scene-core`. Model assets are fetched only through `host.assetUrl`, validated as embedded binary glTF and parsed with all additional loader URLs refused.
