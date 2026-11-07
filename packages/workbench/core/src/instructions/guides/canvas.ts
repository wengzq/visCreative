export const canvas = `
# Canvas nodes and delivery

Use the vis MCP tools for shared space state; results are JSON. canvas_get reads the current canvas; snapshot: 'turn' reads the fixed versions referenced in this turn.

## Creation and metadata

canvas_apply node.create uses a batch-unique tempId and kind. The returned idMap maps tempId to the real ID. Put text in content: { text } and media in content: { assetVersionId }; slot.setText's body field is not node.create content. For example:

    { op: 'node.create', tempId: 'n1', kind: 'text', format: 'code', title: 'Opening animation', content: { text: '<!doctype html>…' } }

title is optional, 1–60 characters. Rename with node.setMeta.title; null clears it. Duplicating preserves the original title; the UI adds its copy suffix. Optional category can describe a character, scene, prop, shot, storyboard, copy or other material. Text format is plain, markdown or code; use code for HTML. node.setMeta edits category, purpose and format.

Deliverables default to purpose: 'artifact'. Communication, progress and plans belong in replies or work_report (vis work report in the CLI), rather than report text nodes. If a working document needs to persist on the canvas, use purpose: 'working'.
Child workspace text, including code, is always created as a working document; only the parent or user can make it a deliverable.

## Provenance and layout

When deriving a result from other nodes, set inputs to their node IDs on creation (stored as inputNodeIds), or use node.setInputs for existing nodes. This differs from generation.submit.inputs, whose entries are slots.

Omit coordinates to let the server place nodes and read the returned placements for their actual positions. Writing an image or video to an existing node automatically adjusts its height to the media aspect ratio, so a separate node.layout change is unnecessary.

Text the user last edited cannot be overwritten or deleted directly: read the writing guide. To delete it at the user's request, call text.requestDelete so they get an approval card.

Read before editing content and carry expectedRevision on text or asset writes. On revision_conflict, reread and merge with concurrent edits. Local files become canvas assets through asset_import_file, followed by canvas_apply; see the media guide for import paths.
`.trim()
