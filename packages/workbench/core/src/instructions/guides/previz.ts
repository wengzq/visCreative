export const previz = `
# Shot previz

Previz and final generation are separate stages. A request to "make a previz" means render only and never paid models; Render previz drafts a request in the composer; it never sends by itself. Only an explicit request to "generate" invokes the generation asking rules below. Drawing, importing, linking and setting first/last frames are free. There is no confirmed state or confirm-previz gate.

Read the previz node with canvas_get first: its main slot contains a versioned document with panels in reading order. Inspect each panel image with the asset tools, plus note, durationSec, shot, use and frameRole. A script is optional; several panels can link to one shot. A deleted shot leaves a stale link.

Before generating, ask only about missing choices, in one message, giving a default for each: propose order-based shot links for unlinked panels; propose first-frame generation for review when a picture could be a sketch or a finished image; state assumptions for missing notes and durations. End with a direct question in one closing message, never just "after you confirm". When nothing is missing, give the plan without questions. Before any paid step, state what will run. Never treat a pending batch approval as permission for individual submissions.

Use composition for sketches: the picture guides generation of a finished first frame. Write framePrompt to follow the layout, not the drawing style. Use frame with first or last for finished pictures. The first panel in reading order is the first-frame candidate; later last panels supply the last frame. Composition references use blockout ?? image and have priority over continuity, cast and style; inspect dropped references in script.batch.plan. Frame panels are materialized freely and reused by batches. Read the script guide before editing shots or starting batches.

Use canvas_apply previz.set with the main slot's expectedRevision. Agents may add panels and edit note, durationSec, shot, use and frameRole; preserve existing underlay, sketch and image, and their panels. Only the user sets blockout. Reread and merge on a revision conflict. Read providers_list and retain the user's model choice before submitting generation.

## Blockout

A blockout checks composition, blocking and camera movement with simple grey geometry; it is previz, never finished footage. Use only the free local render provider, never paid models. Check every panel has durationSec; ask for all missing durations in one message, ending with a direct question, before rendering. Write HTML to a code text node and submit to render/html with its text slot first and panel images as asset-version inputs (/input/0, /input/1, …).

Import three from /lib/three.module.js (its relative three.core.js import resolves), await textures before defining window.vis, and set preserveDrawingBuffer: true. Follow the panels and notes for how figures move. Unless they say otherwise, a walking figure faces its direction of travel: build it facing local +Z with its legs on local X, set the group's rotation.y to Math.atan2(dx, dz), turn it before it moves, and swing legs and arms in opposite phase around local X. An unintended sideways slide reads as a crab walk; look for it in a walking frame. Drive every change and render from window.vis.seek(t), with no timers; window.vis.duration and durationMs must equal the sum of durationSec, at 24 fps or more.

After success, use canvas_apply node.setInputs on the video with the previz node included (retain its code input). Do not set a shot link on the video: the product finds its shots through the panels. Checking your render with asset_frames is fine and touches no panel. Only the user can write frames into panels, because panel.blockout changes which picture later generation follows: when they want that, tell them to click Use blockout frames on the previz card. Never touch panel underlay, sketch or image.
`.trim()
