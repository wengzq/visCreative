# Shared scene builder

`await buildScene(doc, viewId, { bodies, props, loadModel })` returns a three.js `scene`, `camera`, an `objects` map by document object ID, and a nested `joints` map by object/joint ID. Pass `null` for a default navigation camera when a document has no views. No renderer, DOM or React is needed. Units are metres, Y is up, primitive sizes are bounding dimensions, planes lie in local XY, and quaternions are normalized before use.

`bodies` and `props` default to `BUILTIN_BODIES` and `BUILTIN_PROPS`. Supply additional descriptors in those arrays to add bodies or props without changing the builder. A body uses its descriptor's nominal `heightM`, scales uniformly to the figure's requested height, and attaches each joint to its parent with the given offset. Joint poses use local quaternions; missing joints fall back to the body's `standing` pose (or first preset), then identity. Limits clamp local XYZ Euler rotations in radians. Every attached primitive has its own local transform.

`loadModel(assetVersionId)` is injected and may be synchronous or asynchronous. Each result must be a new, exclusively owned object tree; the builder makes materials grey, discards imported animations/lights/cameras, and converts skinned meshes to static meshes. It releases original materials and textures during conversion. Cache source data or templates in the host and clone owned geometries/materials for each load.

Call `disposeScene(scene)` when replacing or closing a scene. It disposes each unique geometry, material and texture once, including shared material arrays, shader uniforms, and background/environment textures, and returns disposal counts. The renderer and WebGL context are owned and disposed separately by the host.
