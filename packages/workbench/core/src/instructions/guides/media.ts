export const media = `
# Local media processing and inspection

Use media_process for crops, grid splits, video/audio trims, extracted frames, audio extraction, audio splits and speed changes. These are free local operations rather than generation jobs. Read the source node's main-slot revision first and supply expectedRevision. Wait for the returned job with media_get or vis media wait. For candidate cuts at silence, use media_analyze with audio.silence.

For assembled clips, captions and transitions, use the timeline guide and timeline.export. Single-source trim, speed and audio extraction need no timeline node.

To inspect video, use asset_frames to sample frames evenly, then pass each frame's path to an image-viewing tool. Use those images to assess shots, composition, color and rhythm; video inspection is limited to those frames.

Audio is not audible to you. Use asset_get for durationMs and mime, and slot_history for the originating prompt, model and parameters. Base observations on those metadata and prompts; asset_frames applies to visual media, not audio.

An asset's path is a local filesystem path. If the model supports images, pass path to read_image or the available image-viewing tool, rather than url (a file:// address). Without image support, skip visual inspection instead of repeatedly attempting it.

Import locally produced images, video or audio using asset_import_file from the session work directory or the project's assets directory, then create a node or fill a slot with canvas_apply. A filesystem path in a reply alone does not deliver the work to the canvas.
`.trim()
