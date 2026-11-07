# 0030 · Generation results in the session

Status: implemented

Date: 2026-11-04

Builds on [0013](0013-agent-activity.md) (session activity), [0015](0015-session-experience.md) (attachments and references) and the poster previews from the stability work.

## Background

- User messages already show reference and attachment thumbnails. Agent replies are Markdown text only.
- What an Agent generates is hidden inside a collapsed tool group as JSON, so the user leaves the session to see it.
- The data is already in the client. `toolGroups.ts` links tool calls to jobs by `jobId`, `space.ts` loads those jobs, and `SessionPanel` receives them as `generationJobs`. `JobView` has `outputs` (asset version, mime, delivered node) and `error`.
- Agent Markdown can contain `![](https://…)`. Raw HTML is off, but nothing stops the browser from requesting an external image, which leaks that the user viewed it.

## Goals

1. Show the results of an Agent's generation jobs in the session automatically, for every Agent, with no change to prompts, including in old sessions.
2. Let the user preview a result, find it on the canvas and reference it in the next message.
3. Stop Agent Markdown from loading external images.

## Out of scope

- Agents placing media inside their text on purpose (a controlled Markdown reference). Revisit once this has been used.
- Script batches, which run on the server without a tool call per job. Their results stay in the script table.
- Canvas text nodes. `MarkdownBody` has the same external image behaviour, but users write these too, so it needs its own decision.
- Storing anything new. The canvas stays the home of results.

## Design

### 1. Result card

A card follows the tool group, outside its collapsed `<details>`, so it stays visible when the group is closed. [RFC 0032](0032-turn-view-send-now-working-docs.md) refines this placement to the last actual tool mention, outside the work block, including late receipts after a visible message.

- **One card per job.** `gen_submit` and later `gen_get` calls name the same job, possibly in several groups. The card appears once, at the last group that mentions the job, so it reads in time order.
- **States:** running with the job's status, succeeded with outputs, failed with the localized reason through the existing error messages, cancelled, and unknown. A job the client cannot load shows no card and no error.
- **Image:** thumbnail grid. **Video:** poster with a play icon. The player mounts only in the preview dialog, so idle sessions hold no video elements. **Audio:** a row with `preload="none"`.
- **Many outputs:** the first four, then "N more", which expands in place.
- **A deleted asset** shows the missing placeholder, not a broken image.
- Thumbnails use `loading="lazy"`. New cards keep the panel's stick-to-bottom behaviour when media loads. Layout reserves the image's space so scrolling does not jump.

### 2. Actions

- Click: the existing attachment preview dialog, with video and audio controls.
- **Locate:** `onLocateRef` when an output has `delivery.nodeId`. Hidden otherwise.
- **Reference:** adds the output to the composer, as a node reference when delivered to a node and otherwise as an `{ assetVersionId }` reference. Disabled in archived sessions.

### 3. External images in Agent Markdown

Every Markdown renderer showing Agent text in `packages/workbench/ui` (`SessionPanel`, `AgentActivity`, `InboxPopover`, `ReviewDrawer`) maps `img` to a plain link labelled with the alt text or URL, with `rel="noreferrer"`. No image loads. Only `http` and `https` become links; anything else shows as text.

## Contract changes

None. `SessionPanel` gains props from the host for poster URLs and asset references.

## Testing

- Unit: one card per job across groups, ordering, state mapping, the output limit.
- Browser e2e with fake Codex and mock providers: a generation shows its card with the tool group collapsed; preview; locate; reference into the composer; a failed job shows its reason; an external Markdown image triggers no request. Video cases assert no `<video>` exists until the preview opens.
- No test calls a paid service.

## Implementation notes

- `generationResults.ts` assigns loaded jobs to their last actual tool mention (refined by RFC 0032) and limits collapsed output lists to four. `GenerationResult` renders cards as siblings of the work blocks; unavailable historical jobs are silently omitted.
- Cards resolve asset metadata through the host, reuse `AttachmentPreview`, and use authenticated poster URLs for video. Video references and attachments also use posters, keeping idle sessions free of video players. A failed poster uses a media icon; a missing asset uses the unavailable placeholder.
- Delivered outputs add node references; undelivered outputs enter the existing attachment draft state as asset references, deduplicated by asset version. Archived sessions disable reference actions while retaining preview and locate.
- Transcript child resize observation preserves bottom pinning as cards load or expand, while existing history anchoring remains in effect. Thumbnail aspect ratios reserve space.
- `AgentMarkdown` is shared by session replies, reasoning, inbox bodies and resolutions, and review reports and history. Image syntax becomes an explicit HTTP(S) link with `rel="noreferrer"`, or text for every other URL scheme; no image element is created.
- Unit coverage checks placement, ordering, states, output limits and URL schemes. `session-results.e2e.ts` uses fake Codex and a mock provider to exercise previews, locate, both reference forms, localized errors, audio preload, poster-only idle video, history reload, output expansion, unavailable jobs and assets, archived actions, bottom pinning, and external-image request suppression.
