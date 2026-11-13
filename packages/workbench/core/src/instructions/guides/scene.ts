export const scene = `
# Interactive scenes

A scene is a shared 3D stage with objects and named camera views. It stands alone or supplies an image or video to other canvas nodes. Read it with canvas_get before editing. Create an empty node with kind: 'scene', then write its main slot with canvas_apply scene.set, carrying expectedRevision and the complete document. Within one batch use tempId:main, initially at revision 1. Keep existing objects and views by stable id; reread and merge on revision_conflict.

## Coordinates and objects

Units are metres, Y is up, and rotations are quaternions [x, y, z, w]; identity is [0, 0, 0, 1]. Each object has id, name, transform: { position, rotation, scale }, hidden, createdBy, userTouched and source. Scene documents have version: 1, rev, objects and views. The slot revision, not doc.rev, controls concurrent edits. The gateway owns createdBy and userTouched; preserve them when editing, and expect new Agent items to become createdBy: 'agent', userTouched: false.

Sources are figure ({ type: 'figure', bodyId: 'human', heightM, pose }), primitive ({ type: 'primitive', shape, size }), group ({ type: 'group', parts }), prop ({ type: 'prop', propId }) or an imported GLB model ({ type: 'model', assetVersionId }). Primitive shapes are box, cylinder, sphere, capsule and plane. Built-in prop ids are bench, chair, table, wall, door and car. Model assets must already be imported into the project.

Build a custom prop such as a bench as one group object. Each part has name, shape, size and its own local transform; moving the group's transform moves all parts together. For example, combine a box seat, back and legs. Use the author's requested dimensions and placement. Limits: 64 objects, 32 parts per group and 32 views.

## Figures and views

Human joint ids: \`pelvis\`, \`spine\`, \`chest\`, \`neck\`, \`head\`, \`leftShoulder\`, \`leftElbow\`, \`leftWrist\`, \`leftHip\`, \`leftKnee\`, \`leftAnkle\`, \`rightShoulder\`, \`rightElbow\`, \`rightWrist\`, \`rightHip\`, \`rightKnee\`, \`rightAnkle\`.

Human preset pose names: \`standing\`, \`walking\`, \`sitting\`, \`pointing\`.

The human figure faces local +Z; its anatomical left is +X. pose maps joint ids to local quaternions, with absent joints at rest. Preset names describe starting poses, not a source.pose string or an instruction to choose a style. Write actual joint quaternions: sitting uses both hips rotated -90 degrees around X and both knees +90 degrees around X; these are [-0.70710678, 0, 0, 0.70710678] and [0.70710678, 0, 0, 0.70710678]. Adjust the whole figure's position to meet the seat and inspect a frame. Joint limits are applied by the builder.

Each view has id, name, camera: { position, target, roll, focalLengthMm }, aspectRatio, still, createdBy and userTouched. Camera roll is in radians; focal length is 8–300 mm on a 36 mm sensor. Aspect ratios are 16:9, 9:16, 1:1, 4:3, 3:4 and 21:9. The author decides framing. Objects belong to the stage and are shared by all views.

## Motion

Set durationS for motion (0.1–120 seconds); omit it for a static scene. Object tracks may contain transform keys, pose tracks keyed by joint id (figures only), and hidden keys. A transform key is { t, value: { position, rotation, scale }, ease }; a pose key is { t, value: [x, y, z, w], ease }. Views may have cameraKeys: [{ t, value: { position, target, roll, focalLengthMm }, ease }].

Times are seconds, nonnegative, strictly increasing within each track and no later than durationS. Each track has at most 512 keys and the scene at most 8192. A key's ease shapes the segment to its next key: linear, easeInOut (smoothstep) or hold. Rotations use shortest-arc slerp. Before the first and after the last key, the endpoint holds. Visibility is stepped: hidden keys are { t, value: boolean } with no ease. Untracked properties retain their static values. All views share the same object motion and each has its own camera move.

For walking, turn the figure toward its travel direction, key the whole transform across the stage and alternate opposing arms and legs with pose keys. Follow the author's action and timing; a single translated static pose will slide. Use image frames to check feet, direction and camera coverage.

## Check and render

Use the free local provider only: provider: 'render', model: 'scene'. Never suggest paid providers for scenes. Read providers_list, then submit with gen_submit and a nonempty prompt. The scene slot must be the first input: inputs: [{ slotId, revision }]. params accepts viewId, width, height and fps (1–60, default 24).

For one frame use kind: 'image' and params.timeS in seconds, for example { viewId: 'wide', timeS: 2, width: 960, height: 540 }. Inspect the resulting image to check the work. For the whole scene use kind: 'video'; duration comes from durationS, and a static scene cannot render a video. After a successful video render, extract and inspect frames with asset_frames. Generation snapshots the scene revision at submission; keep the rendered source and its provenance on the canvas.

## Protect the author's work

You may add objects and views, and change or delete only existing items with createdBy: 'agent' and userTouched: false. Tracks and cameraKeys are part of that content. The gateway ignores client ownership flags, compares by id and protects author-made or author-touched items. Reordering objects or views is allowed. A view's still is an output of the author's saves: Agents cannot set or clear it; the gateway preserves previous stills and uses null for new views. Saving a still alone does not mark a view touched.

On scene.object_protected, scene.view_protected or scene.duration_protected, call scene.propose with requestId, slotId, the current baseRevision, intended changes and a one-sentence summary. Changes update or delete existing objects or views, or set durationS (null clears it). Updates carry item content without createdBy, userTouched or still; the server fills base. Tell the author a proposal is waiting in the scene editor. Do not retry the write or change flags, replace ids or delete the scene to bypass protection. Use scene.proposal.list to read review states; resolving a proposal sends no message to your session. You may change durationS only if protected object and view keys still fit. You may delete a scene only when every object and view is Agent-made and untouched. panel.blockout and sceneRef stay user-only; ask the author to send a scene view through the UI when that is what they want.
`.trim()
