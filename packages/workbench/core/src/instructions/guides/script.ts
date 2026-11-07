export const script = `
# Script documents

Read the script node with canvas_get before editing. Its main slot contains { type: 'script', doc: ScriptDoc }; the prompt slot holds the original script or requirements. Use canvas_apply script.replace for the first breakdown, then script.patch for focused changes. Tool schemas describe the fields and limits.

## Replacing and patching

script.replace takes slotId, expectedRevision and doc. Shots and assets use unique tempId values; the server allocates IDs and revisions, and shots can reference asset tempIds. Omitting style or sessionId preserves the existing value; explicit null clears it. To change only the responsible session, use doc.set.

script.patch takes slotId, expectedRevision and ops; each op is discriminated by kind, for example:
{ op: 'script.patch', slotId, expectedRevision, ops: [{ kind: 'shot.update', shotId, rev, fields: { description, framePrompt } }] }

shot.insert uses tempId, afterShotId and shot; afterShotId: null inserts at the beginning. Later operations in the batch can reference earlier tempIds. shot.update and shot.delete use the row's current rev; shot.move changes order. asset.insert / update / delete work similarly, and doc.set uses the document rev. On revision_conflict, inspect params.currentRows (JSON) or reread with canvas_get and merge.

The doc carries no version field; shots have no title field. Limits are 200 shots, 100 assets, 4000 characters per text cell, and 200 operations per patch. Shot durationSec ranges from 0.5 to 60 seconds. Assets are character, scene or prop and are project settings shared across scripts (doc.castIds and doc.styleId select them; read the library guide before creating any); names deduplicate within a kind after trimming and case folding. sceneId refers to a scene, characterIds to characters and propIds to props. Text cells reference assets as {{asset:<id>}}. See the generation guide for reference-image markers.

promptState is server-maintained. Preserve rows marked edited when generating prompts unless the user explicitly requests replacement. Change only the requested rows.

## Manuscript adaptation

When the writer asks to break a selection or chapter into shots, read the writing guide, use the named script or create a new script node, then write through these script tools. Keep the manuscript unchanged. Give every adapted shot source: { nodeId, quote }, quoting a passage exactly as written that occurs once in the source body. Repeated text needs a longer quote. The source supports navigation; it does not keep shots in sync. Read entity.list and reuse same-kind same-name castIds without supplying replacement descriptions through legacy asset aliases. Report existing settings instead of overwriting them.

## Shot design

cut is a hard cut; continuous continues the preceding shot's ending image. The first shot is cut. description and framePrompt describe a single static first frame, rather than a sequence of actions. Add endState and endFramePrompt when the ending image differs from the first. videoPrompt describes action, camera movement and duration. A continuous shot picks up the preceding ending image with consistent character positions, scene and lighting. Carry the overall style and asset designs through every shot. Cuts, end states and shot structure are creative proposals: say briefly why you chose them, and the author changes what they want.

Read the previz guide when shots use drawn panels or imported frames. Composition framePrompt must follow the layout, not the drawing style.

## Batches

Use script.batch.plan to inspect task counts, models, quota and warnings, then script.batch.start. The core approval guardrail applies: wait for the user; a pending approval is not permission to submit individual jobs. After rejection or expiry, wait for the user's decision rather than retrying automatically. script.batch.get can wait for status; cancellation is limited to batches started by this session.

By default generate shot images first (first frames, plus last frames where endState exists), let the user review each row, then generate videos. A continuous shot's first frame references the preceding last frame, falling back to its first frame; a last frame references its own first frame. Video generation uses frames.first / frames.last for frame slots. Actual-last-frame strict mode is for continuity that needs the preceding video to finish first.
`.trim()
