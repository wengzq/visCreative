# 0029 UI spec · Panels and blockouts on the canvas (steps b–c)

Date: 2026-11-04

> Render library copy follow-up (2026-11-07): built-in service settings describe anime.js, rough.js, three.js and optional author-managed `render-libs` scripts. Missing libraries use `render.lib_missing` with a filename and localized folder guidance in Chinese and English. This does not change the panel or blockout interactions below.

Revises the step b and c scope of [RFC 0029](0029-shot-previz.md). Generation happens on the canvas; the full-screen editor stays for drawing. Copy below is indicative: final strings go in `messages.ts` in both languages.

## Principles

- The user should see what a panel is linked to, and what the next click will do, before clicking.
- Linking is optional. Generating one panel needs no script; only batches need shots.
- Previz is free preparation and review; final generation is a separate stage. They share one node, with separate entries and wording. The full-screen editor contains drawing, importing, notes and duration, plus Render previz in its header; it has no final-generation controls or model picker. There is no confirmed state or confirm-previz gate.
- Batches keep the existing confirmation, and a single job starts only from an explicit click.

## Card: a horizontal strip

The card shows every panel in reading order, replacing the 2×2 grid and its "N more" badge.

- Each tile: picture, number badge top left, shot badge top right when linked (`镜 5`), and the note below in at most two lines.
- Overflow scrolls sideways through a horizontal trackpad gesture, Shift+wheel or the end arrows. A vertical wheel keeps panning and zooming the canvas (RFC 0019 polish), so the strip must not capture it.
- The footer keeps the panel count and Open, and adds **Render previz**, **Link in order** and **Batch generate**.
- A stale link (shot or script deleted) shows a warning badge on the tile.
- Empty card: unchanged.

## Render previz and blockout review (step c)

Render previz adds a previz node reference and localized request to the current session composer, appending to existing text and focusing it. It never sends: an Agent turn has its own cost. Missing durations do not block the action; the draft asks the Agent to gather them in one message. In the full-screen editor header, save first, then close and focus the draft. If saving fails or conflicts, keep the editor open with its error and add no draft.

The newest completed video whose `inputs` include this previz is its blockout; if it has a shot link, the role must be `previz`. Agents set that association with `node.setInputs`. When present, the card footer area shows its poster, play control and **Use blockout frames**. No player mounts until playback or preview. Without a blockout the card adds no review area.

Use blockout frames calls `previz.extractBlockout` with the current slot revision. Reread and retry once on a revision conflict. Localize errors and name panels missing durations by number and note. Extraction changes `blockout`, preserving panel pictures. Tiles keep the user's picture visible and show a small marker; for composition, the popover says “Composition uses the blockout frame”.

Script rows show a shot's blockout, found through the panels linked to that shot, with a poster, dashed border and “Blockout · Previz only” label, visually separate from first/last/video outputs. Blockouts remain excluded from batch outputs and assembly.

## Selecting a panel

- Click a tile: the node is selected and that tile is highlighted. The selection is local UI state, not document data.
- Double click a tile: opens the editor on that panel.
- Escape, or a click elsewhere, clears it. With the strip focused, left and right arrows move the selection.
- The floating panel below shows the selected panel, positioned like the image node's prompt panel.

## Panel popover

```
┌ Panel 3 ─────────────────────────────┐
│ Previz · Free                         │
│ Shot      [ 5 · Rainy street corner ▾ ]│
│ This image (•) Composition reference   │
│            ( ) Use as first frame      │
│            ( ) Use as last frame       │
│                [ Set as first frame ] │
│ ───────────────────────────────────── │
│ Generation · Paid                     │
│ Prompt    [ …                        ] │
│ Model     Seedream ▾                   │
│                       [ Generate frame ]│
└────────────────────────────────────────┘
```

The Previz section owns shot links, image use, and free Set as first frame / Set as last frame actions. The Generation section owns prompt, model and Generate actions. Its Paid marker is visible exactly when the chosen provider declares `needsKey`; it is absent for mock and render without testing provider IDs. Shot selects and radios use the existing theme. The model popover opens next to its trigger and remains usable at every corner. Only final-output actions say Generate; Render previz follows the free draft workflow below.

**Defaults.** A panel with only a sketch or both layers defaults to composition. A panel that is only an imported underlay defaults to first frame.

**Primary action, by state:**

| Use | Shot linked | Previz action (free) | Generation action | Result |
|---|---|---|---|---|
| Composition | either | — | Generate frame | Image node beside the card, with the panel as input; linked to the shot as `first` when there is one |
| First frame | no | Disabled until linked | Generate video | A visible unlinked input image node holds the panel for `frames.first`, then a video node is created through the video model picker; FrameRef remains slot-based |
| First frame | yes | Set as first frame | Generate video | Image node linked as `first`; video linked as `video` |
| Last frame | yes | Set as last frame | — | Image node linked as `last` |
| Last frame | no | Disabled | — | Hint: link a shot first |

Generating a video materializes its frame input for free if needed; selecting Set as first frame alone never starts a generation job. Last-frame panels have no final Generate action.

No picture: the applicable action is disabled with "Draw or import first". A blocked model uses the model picker's existing warning.

## Linking

**Shot dropdown.** Lists shots as number plus description, grouped by script when the project has several. "None" clears the link. Several panels may share a shot.

**Link in order** opens a dialog: pick a script when there are several, then a preview table of panel to shot. Existing links stay unless "Replace existing links" is on. Extra panels stay unlinked. Nothing changes until confirmed.

**No script.** The dropdown offers "Ask the Agent to create shots". It adds a reference to the previz and a draft message to the composer of the current session. It never sends on its own.

**Script table.** Each row shows thumbnails of its linked panels. Clicking one locates the card and selects the panel.

## Batch generate

Enabled once a panel is linked. It opens the existing script batch confirmation for the linked shots, initially for images, with a media selector for videos and a script selector when needed. The confirmation states how many composition references are used, and which were dropped because the model accepts none or its reference budget is full.

At confirmation, linked `use: frame` candidates are materialized as first or last image nodes for free. This is idempotent: the newest node for the same shot and role is reused when it already contains that asset version. The first panel in reading order is the first-frame candidate; later last-frame panels supply the last frame. In image batches, these first and last steps are skipped and the estimate reports that the panel image is used. Finished panel pictures therefore survive an image batch without a replacement generation job. Video batches reuse the materialized nodes. Planning remains read-only; materialization happens only after the user confirms (or approves an Agent batch).

## Agent: asking before acting

A new `previz` guide (moved here from step c) tells Agents how to read panels and when to ask. A request to "make a previz" is render-only and never invokes paid models. An explicit request to "generate" triggers the following asking rules. When asked to generate from a previz, the Agent reads it first and asks only about what is missing, in one message, with a default for each point:

- panels with no shot link: proposes order-based links;
- pictures it cannot tell apart as sketch or finished: proposes first frames for review;
- missing notes or durations: states the assumption;
- before any paid step: states what will run.

When nothing is missing it gives the plan without questions. Agents may edit `note`, `durationSec`, `shot`, `use` and `frameRole`. Prompt text cannot guarantee this behaviour, so cost still rests on batch confirmation and approvals. Tappable question cards are out of scope.

## Accessibility and motion

Tiles are buttons with `aria-pressed`, named by number and linked shot. Selection is not shown by colour alone. Scrolling to the selected tile respects `prefers-reduced-motion`.
