export const timeline = `
# Timeline editing and export

For assembling shots, music, voice-over, sound effects, captions, transitions, logo or sticker overlays and picture-in-picture, create a kind: 'timeline' node with canvas_apply node.create, usually with content.timelineFrom in shot order, or edit an existing timeline. Editing uses local processing and does not submit generation jobs. For a single crop, trim, speed change or audio extraction, use the media guide instead.

Read the main slot's { type: 'timeline', doc } with canvas_get. Write the complete document using canvas_apply timeline.set with slotId and expectedRevision. On revision_conflict, reread and merge. Tool schemas describe the full document; these are the timing and editing conventions.

## Assembly and sources

timelineFrom image items may be { nodeId, durationMs } for a display length of 500–30000 milliseconds. Assemble a script in shot order using each shot's newest video result (largest nodeId, because ULIDs sort chronologically), otherwise its first frame with durationSec converted to milliseconds; skip shots with neither result.

The version: 1 document supports 1 video track, 2 overlay tracks, 4 audio tracks, 200 clips per track (50 per overlay track) and 30 minutes total. Order tracks as the video track, then overlay tracks bottom to top, then audio tracks. Tracks have id, kind, muted, volume, clips and an optional name. Name audio tracks by purpose, such as Music, Effects or Voice-over. Video tracks accept video and images; audio tracks accept audio or a video's audio. Copy source: { nodeId, assetVersionId } from the source node's current main slot to pin that version: regeneration then leaves existing edits unchanged.

Clips have unique IDs and startMs, inMs, outMs, volume, fadeInMs and fadeOutMs. Times are integer milliseconds; volume is 0–2. Each fade is at most 10 seconds and both fades fit within the clip. Image clips have inMs: 0 and display for 0.5–30 seconds. Video clips run continuously from zero, with overlap only for transitionIn. Audio clips are sorted by startMs and do not overlap within a track.

## Speed and transitions

speed is 0.25–4 with up to two decimal places, defaulting to 1, for video or audio sources. Omit speed for images, including speed: 1. inMs/outMs stay in source time; timeline length is round((outMs - inMs) / speed). Audio preserves pitch. Fades use timeline milliseconds and fit within the adjusted length.

From the second video clip onward, transitionIn can be { kind: 'crossfade' | 'dip', durationMs: 200–2000 }. Set startMs to the preceding rounded end minus the transition duration. Each transition fits both adjacent clips; a clip's incoming and outgoing transitions together fit its length. First video clips and audio clips have no transitions. Original sound crossfades automatically during overlap; clip fades serve a different purpose. Recalculate subsequent video startMs values after speed or transition edits; independent audio stays in place and remains non-overlapping.

## Overlays (logos, stickers and picture-in-picture)

Overlay tracks ({ id, kind: 'overlay', muted, volume, clips, optional hidden }) draw images or videos above the video track and below text. Overlay clips are sorted by startMs and do not overlap within a track; gaps are allowed and they never take transitionIn. An overlay image may last from 500 milliseconds up to the whole timeline (inMs: 0, outMs is the display length); the 30-second limit applies only to images on the video track. An overlay video is picture-in-picture: inMs, outMs and speed follow the video-track rules, and its sound plays at clip volume × track volume. hidden hides only the picture; to silence a picture-in-picture, set the overlay track's muted to true or the clip volume to 0. Example, shot 3 in the bottom right during shot 1: an overlay track with shot 3 at shot 1's startMs, outMs no longer than shot 1, overlay: { x: 0.8, y: 0.8, width: 0.33, opacity: 1 }. The editor preview plays one overlay video at a time; export renders every overlay.

Transparent WebM from the render provider keeps alpha on overlay tracks in preview and export. Read the code-render guide and pass transparent: true for motion graphics; use the provider instead of launching Chrome inside the sandbox. Transparent main-track clips composite over black.

Every overlay clip needs overlay: { x, y, width, opacity }. x and y are the overlay's centre as fractions of the output width and height (0–1, three decimals); width is the overlay width as a fraction of the output width (0.02–1); height follows the source aspect ratio; opacity is 0–1 with two decimals. Example, a logo in the top right for the whole film: overlay: { x: 0.9, y: 0.1, width: 0.12, opacity: 1 } with startMs: 0 and outMs equal to the timeline length. On overlay clips fadeInMs and fadeOutMs fade the picture and, for videos, the sound. Overlays stay at absolute times: unlike captions, do not move them when shots move unless the user asks. Other clips must not have an overlay field.

## Text and fonts

doc.textTracks is separate from media tracks, supports 2 tracks and draws above the image; hidden tracks are omitted. A text track is { id, hidden: false, clips } with no kind field, for example:
{ id: 'subs', hidden: false, clips: [{ id: 'c1', startMs: 0, durationMs: 800, text: 'Shot one', style: { preset: 'subtitle' }, fadeInMs: 100, fadeOutMs: 100 }] } Text clips use absolute timeline milliseconds, sorted without overlap within a track. Each has id, startMs, durationMs (at least 200), text, style, fadeInMs and fadeOutMs. Text is 1–200 characters, at most 3 lines; actual newline characters create lines and there is no automatic wrapping. style.preset is subtitle, variety, cinema or title; overrides include font, sizePct (2–20% of output height), color (#RRGGBB) and position (bottom, middle or top).

Use font_list (font.list) to discover the four built-in fonts and the project's latest font asset versions. Reference a font with { builtin: id } or { assetVersionId }, rather than a file path or node ID. Import user TTF/OTF files with asset_import_file; fonts are assets without canvas nodes, and the user is responsible for licensing. If built-in fonts are missing, ask the maintainer to run pnpm fonts:fetch.

The editor's caption linking applies only to UI edits. When moving, trimming, changing speed or changing transitions, shift text whose start lies in the affected video clip by the same displacement so captions follow the original shot, unless the user asks otherwise. Transition overlap belongs to the later clip. Delete linked text when deleting a clip; independent audio stays put.

## Export and capability boundaries

Export with media_process (media.process), operation: 'timeline.export', params: {}, the timeline nodeId, main slotId and current expectedRevision. Wait with media_get (media.get) or vis media wait. The result's exportOf links the source timeline and revision. Keep source shots, timeline and exported film in the same Frame when useful. Text-only exports have a black background with output settings or the default 1920×1080 at 30 fps.

Rotation, cropping and keyframed motion are unsupported; explain this limit rather than inventing fields. Captions and transitions are authored in the timeline document and rendered by timeline.export, rather than other media.process operations. Describe a result as complete only after processing and inspecting it. If export fails because of the local environment, such as media.captions_unavailable (FFmpeg without the ASS filter), report the error to the user; do not build a substitute export yourself or attach your own file to the export node.
`.trim()
