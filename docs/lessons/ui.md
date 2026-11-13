# UI lessons

## A remounted board can disagree with its host's data scope

- **Symptom:** opening the board briefly reads current-project data before loading all projects, or reads both scopes when reopened.
- **Cause:** the board's local scope resets on mount while the host's fetch scope survives Canvas/Board switches.
- **Instead:** initialize both scopes to the same default and reset the host while the board is unmounted. Cover the first opening and a return from Current project with RPC-scope assertions, while selecting Current project explicitly in tests of expanded card details. Cache checks after a reload must await a new read and its completion: request counters can already contain reads made before the reload.
- **Found in:** [RFC 0009 amendment](../rfc/0009-work-items-and-board.md), `WorkBoard.tsx` and `apps/web/src/client/WorkUI.tsx`.

## An edge can exist in React Flow's store without a rendered path

- **Symptom:** generation output and its source edge are present in the browser's store, but no edge DOM appears, even after a ten-second wait. The result node has measured dimensions but no cached handle bounds.
- **Cause:** handles already render unconditionally. React Flow measures them before returning the first dimensions callback to controlled node state. If a content or status update intervenes while that node still omits `measured`, React Flow interprets the omission as reinitialization and clears its handle cache. A later dimensions acknowledgement does not restore those bounds, and an unchanged-size node need not emit another resize. Provenance arrives with asset delivery; no later canvas reread, animation or viewport culling gates this edge.
- **Instead:** give each new flow node an empty `measured` record and preserve it through reconciliation until React Flow supplies dimensions. Leave width and height unset in that record rather than inventing measurements. Regress the gap by holding dimension callbacks, updating content, then acknowledging the dimensions and checking both cached handles and the exact edge count; retain the original source-edge waits. The serial web fixture shares its page and project, so an early failure can skip cleanup and cascade into later cases.
- **Found in:** [RFC 0025 first-measurement correction](../rfc/0025-performance.md#first-measurement-handle-retention-2026-11-13), [controlled-node browser regression](../../apps/web/e2e/canvas-rendering.e2e.ts).

## An attachment receipt can precede its reference number

- **Symptom:** picking an unattached canvas source inserted a missing-reference chip or silently skipped insertion even though attachment succeeded.
- **Cause:** the Add reference action resolves on the RPC receipt, while its canvas event and React reference numbering can arrive later. The old insertion guard correctly accepts only numbered attached references.
- **Instead:** preserve the search selection, await attachment, then wait for the attached reference to appear before inserting the marker. Keep the editor busy until that handoff completes, and leave the search text untouched on failure; text undo must never undo the attachment. Block edits without toggling `contentEditable` during the request: the toggle can discard focus and reset the restored caret to the start, so immediately typing after a pick prepends text.
- **Found in:** [RFC 0021 amendment](../rfc/0021-node-components.md#amendment-pick-canvas-media-with--maintainer-2026-11-11), `PromptRefInput.tsx`.

## Raw drag coordinates can miss a canvas node during fitting

- **Symptom:** the text-card drag acceptance panned the canvas while the stored node position stayed unchanged; the same case passed alone.
- **Cause:** two equal viewport samples can occur while fit animation frames are delayed. A raw bounding box and mouse move do not wait for the actual drag handle to become stable, so the subsequent press can hit the pane.
- **Instead:** hover the handle through a Playwright locator before measuring and pressing. Its actionability checks wait for a stable, reachable element; keep the persisted-position assertion and drag distance intact rather than adding a sleep.
- **Found in:** [canvas drag acceptance](../../apps/web/e2e/canvas-organization.e2e.ts).

## A full-size `nodrag` container makes its canvas node immovable

- **Symptom:** script cards and audio nodes could not be dragged; only the small title label above the node moved them.
- **Cause:** `nodrag nopan` sat on the script card body and the audio player, and both fill the node at 100% width and height, so React Flow never started a drag from inside the node.
- **Instead:** put `nodrag` only on the controls that own the pointer (inputs, seek strips, editors) and leave the node body as a drag surface. Plain buttons do not need it, because a press without movement still clicks. Cover each node kind with a body-drag e2e that checks the stored position.
- **Found in:** `ScriptNode.tsx`, `AudioPlayer.tsx`, [canvas drag acceptance](../../apps/web/e2e/canvas-organization.e2e.ts).

## Canvas visibility must not decide whether an attached reference exists

- **Symptom:** `@` offered no choices and existing chips became missing references after attached image or video sources were hidden as working nodes.
- **Cause:** selected-node snapshots and prompt editors resolved input IDs against the filtered visible canvas list. Valid media then had neither a resolved node nor a reference number.
- **Instead:** retain the complete project node list for selected-node reference lookup while keeping layout and picking on visible nodes. Exercise Add reference, upload and incoming inputs, then hide sources and verify both chips and persisted markers; keep unselected media snapshots lightweight.
- **Found in:** [RFC 0021 §8](../rfc/0021-node-components.md#8-输入面板), `CanvasView.tsx`.

## A deferred number-field reset can corrupt the next edit

- **Symptom:** after a scene key-time collision was rejected, replacing the time with `2` sometimes moved the key to the duration's end instead.
- **Cause:** the number field copied its committed value into draft text in a passive effect after blur. Refocusing before that reset completed let it replace the next edit or invalidate the browser's text selection: an intended `2` became `32`, then clamped to `5` seconds.
- **Instead:** display the committed value directly while blurred and initialize draft text in the focus handler. Keep typing independent of deferred prop synchronization, including when a parent rejects a commit; test refocusing before pending effects run.
- **Found in:** [RFC 0037 step c](../rfc/0037-interactive-scene-nodes.md#step-c-motion), `packages/scene/ui/src/fields.tsx`.

## A named settings link needs an explicit destination

- **Symptom:** the prompt panel's Media hosting settings link opened the general generation-services pane.
- **Cause:** it reused a settings callback that carried no section, so opening the dialog did not select hosting.
- **Instead:** carry the hosting destination through the existing settings callback and verify the active pane in a browser test before filling any fields. Keep the model picker's general services action on its default destination.
- **Found in:** RFC 0043 integration, `PromptPanel.tsx` and `App.tsx`.

## Poster previews do not provide reference duration metadata

- **Symptom:** video references show a poster but the panel cannot check per-clip or total-duration limits before submission.
- **Cause:** canvas slot views contain the pinned asset ID, not duration, and a poster image never emits video metadata events. Loading a video decoder for every poster also defeats poster-first previews.
- **Instead:** resolve pinned asset metadata through the host's existing asset resolver and cache durations by immutable version. Fetch only missing versions, retain the resolver in a ref, and do no work for an empty video list. Let the server validate missing durations with a non-blocking note; offer retry only after an actual fetch failure. An operation subject does not need this metadata fetch. Read video limits and the optional hosting requirement from the model catalog; provider names cannot tell whether a model is local or needs hosting.
- **Found in:** [RFC 0043 §7](../rfc/0043-video-references-and-media-hosting.md#7-ui), `packages/canvas/ui/src/use-video-references.ts`.

## A popover opened from `contextmenu` closes at once on macOS and Linux

- **Symptom:** right-clicking a work card showed its menu for a moment, then it disappeared. Windows was fine.
- **Cause:** macOS and Linux fire `contextmenu` while the button is still down. A `popover="auto"` opened in that handler sees the following button release outside itself and light-dismisses. Windows fires `contextmenu` after the release.
- **Instead:** on platforms that fire before the release, open the popover after the `pointerup`/`mouseup` that ends the gesture; open it directly where the event already follows the release. Cover it with an e2e right-click that checks the menu is still visible after the release.
- **Found in:** 1d21f32 (`packages/workbench/ui/src/work/WorkCardMenu.tsx`).

## Area-weighted placement throws the prompt panel to a far corner

- **Symptom:** on a dense canvas, selecting an image put its prompt panel in a distant canvas corner instead of under the image.
- **Cause:** candidates were scored by overlap area (px², weighted) plus distance (px), and every card's label counted as a hard control. Covering any neighbour outweighed any distance, so an empty corner always won.
- **Instead:** try the positions attached to the selected card first (below, above, left, right) and take the first that clears only what must stay clear: that card, its own controls and fixed canvas controls. Search free space only when none fits.
- **Found in:** `packages/canvas/ui/src/prompt-panel-bounds.ts`.

## Unifying node widths stretches media

- **Symptom:** after Organize, portrait images showed as squares with heads and feet cropped.
- **Cause:** `arrangeCanvas` set every member to the group width but kept its height; media cards use `object-fit: cover`.
- **Instead:** scale image and video heights with the new width, and send `h` in the `node.layout` op.
- **Found in:** `packages/canvas/ui/src/organization.ts`.

## Organizing placeholders leaves cards overlapping once images land

- **Symptom:** after Organize, images in a frame covered the row below once their generations finished.
- **Cause:** Organize laid out 320×180 placeholders; delivery then grew each card to its asset's aspect ratio without moving the cards below.
- **Instead:** `fitNodeToAsset` pushes the cards it newly reaches down its column by the growth, in the same operation and undo step. Only inside a frame: on the open canvas, or onto a nested frame, a push would change frame membership behind the author's back.
- **Found in:** `packages/canvas/core/src/fit.ts`.

## React event targets do not survive a deferred state updater

- **Symptom:** editing a hosting field removed the settings dialog and raised a page error before the next field could be filled.
- **Cause:** the functional `setState` updater read `event.currentTarget.value`; React can execute that updater after the handler returns, when `currentTarget` has been cleared.
- **Instead:** read the input value inside the event handler, then close over that value in the updater. Exercise sequential field edits in the browser, because static render tests cannot catch it.
- **Found in:** [RFC 0043 §1](../rfc/0043-video-references-and-media-hosting.md#1-hosting-setting), `MediaHostingSettings.tsx`.

## The rotate gizmo swallows clicks on the knee marker

- **Symptom:** in the 3D scene, a standing figure's knee marker could not be selected; hips and shoulders could.
- **Cause:** the rotate gizmo sits on the figure root or the selected joint, and its ring radius is about 0.5 m at the default camera distance. A knee is 0.52 m above the feet and 0.42 m below the hip, so it lies on the ring pick area. `TransformControls` sets `axis` on hover, and the viewport treated every press with an axis as a gizmo grab and skipped selection.
- **Instead:** on a click that stayed within 4 px, let a marker under the pointer win over the gizmo only if that gizmo gesture committed nothing; a small real drag still commits, and then it must not also reselect. Drop the remaining gizmo presses, so one on empty space keeps the current selection.
- **Found in:** `packages/scene/ui/src/SceneViewport.tsx`.

## Stepping a joint angle past 90° on Y snaps it to an unrelated pose

- **Symptom:** a keyboard nudge on a bent elbow at Y=50° (Shift+Right) gave (-150, 80, 0); a neck at its 55° stop jumped to (-35, 55, -35).
- **Cause:** the step was added to one XYZ Euler angle, converted to a quaternion and clamped. An XYZ decomposition keeps Y within ±90°, so an angle past it reads back with X and Z flipped by 180°, and `clampJointRotation` then picks the nearest stops of those flipped angles.
- **Instead:** clamp the edited axis to its limit before converting (`setJointAxis` in scene-core), and use it for every single-axis edit. At exactly ±90° Y the decomposition is gimbal locked and folds Z into X, so compare orientations there rather than angles.
- **Found in:** `packages/scene/core/src/pose.ts`, `packages/scene/ui/src/nudge.ts`.

## Scene edits must go through the playhead once motion exists

- **Symptom:** after merging keyboard nudges with the motion editor, arrow keys on a keyed object changed nothing visible, and playing a visibility key rebuilt the whole stage every frame.
- **Cause:** the nudge wrote the static transform, which a transform track overrides, and the viewport's rebuild signature still included `hidden` and `tracks`, which change without new geometry.
- **Instead:** edit what `sampleScene(doc, t)` shows and write it back through `editMotionObject`, which sets or updates a key when the property has a track. Keep the rebuild signature to geometry (sources and structure) and apply placement, visibility and poses in place.
- **Found in:** [RFC 0037 step c](../rfc/0037-interactive-scene-nodes.md#as-built-steps-c-and-d-2026-11-10), `SceneEditor.tsx` and `SceneViewport.tsx`.

## Scene proposal acceptance must adopt its own external revision explicitly

- **Symptom:** accepting a proposal after editing in the scene editor showed a conflict even though the local edits were saved first.
- **Cause:** the draft deliberately treats incoming writes after local interaction as conflicts. Proposal acceptance commits a separate author write through the gateway, so its event is not an editor-save echo.
- **Instead:** register the mounted draft with the project host, flush it before acceptance, reread the saved revision and resolve against it. After the accepted revision is read, explicitly adopt it only if the draft still has that flushed base revision and no unsaved work. Keep edits made during the request and leave genuine revision conflicts for an author retry. Preview remains an overlay sampled at the playhead, never a draft edit or an output still.
- **Found in:** [RFC 0044 step b](../rfc/0044-scene-change-proposals.md#as-built--step-b), `scene-proposals.ts` and `packages/scene/ui/src/draft.ts`.

## Fake CLI calls do not create transcript tool receipts

- **Symptom:** a browser fixture created valid proposals in the database but rendered no session cards.
- **Cause:** the fake Agent invoked the CLI directly without emitting Codex's `mcpToolCall` start/completion notifications. Service state cannot substitute for the structured historical receipt used by card derivation.
- **Instead:** emit the same tool lifecycle events as the adapter receives, including the actual successful CLI result as the tool-result text. Assert both live state and receipt-derived cards in the browser.
- **Found in:** [RFC 0044 step b](../rfc/0044-scene-change-proposals.md#as-built--step-b), `apps/web/e2e/fake-codex.mjs`.

## Preview navigation is separate from document editing

- **Symptom:** scrubbing or orbiting dismissed a proposal preview, and hovering a different change replaced a pinned choice.
- **Cause:** a root change/pointer handler treated navigation as an edit, while one boolean could not identify the pinned proposal independently of hover.
- **Instead:** end preview on document changes, keep playhead and viewport navigation read-only, and retain the pinned proposal ID across hover/focus changes. Resolve the requested proposal before consuming Escape, so loading or terminal proposals do not swallow the close action. Compare rendered samples and camera positions in interaction tests.
- **Found in:** [RFC 0044 step b](../rfc/0044-scene-change-proposals.md#as-built--step-b), `SceneEditor.tsx`.

## Proposal outlines need their own resource cleanup

- **Symptom:** proposal outlines retained GPU buffers when the viewport closed.
- **Cause:** `BoxHelper` is a line helper, while the general scene disposer handles meshes; leaving it attached to the helpers scene did not release its geometry and material.
- **Instead:** let the outline owner remove and dispose every helper on teardown as well as when its selection changes. Verify geometry and material disposal against real helpers, including a repeated teardown.
- **Found in:** [RFC 0044 step b](../rfc/0044-scene-change-proposals.md#as-built--step-b), `proposal-outlines.ts` and `SceneViewport.tsx`.


## Display catalogs must not block review data

- **Symptom:** opening a review waited for a slow model catalog, each review reload issued another request, and cards showed a raw id while the drawer showed the display label.
- **Cause:** optional display metadata was awaited with the review load, and card/drawer labels had separate implementations.
- **Instead:** render review data independently, share a per-kind client cache for pending, successful and briefly failed catalog reads, and resolve labels after render. Keep one indexed session-label helper and a separate stable accessible name for the session button; show effort-only and tier-only settings too. Hold a catalog response in the browser test and verify review actions remain usable before releasing it.
- **Found in:** [RFC 0049 review corrections](../rfc/0049-child-agent-model.md#review-corrections-2026-11-13), `packages/workbench/ui/src/agentModels.ts` and `work/sessionLabels.ts`.
