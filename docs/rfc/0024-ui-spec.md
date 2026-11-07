# 0024 appendix · Timeline editor UI spec (step 0024b)

Status: implemented (0024b, extended through 0024e/E2); remaining platform and real-Agent checks are listed in 0024 (2026-11-05)

Date: 2026-11-01

Visual and interaction spec for the timeline editor in [0024](0024-timeline-editing.md) §5–§6. Written in English so implementation workers can use it directly. Where it conflicts with 0024, 0024 wins for behavior and this file wins for layout and visuals.

Visual baseline: the existing dark theme (`packages/ui-kit/src/theme.css`) and the video / audio node references in `F:/workspace/设计参考图/` (dark rounded cards, light-gray waveform bars, a quiet top toolbar). The editor should feel like a larger version of those nodes, not like a separate pro NLE: few borders, flat surfaces, one accent color for selection and primary actions.

## 1. Principles

1. **The timeline is the hero.** Panels around it stay quiet: no heavy borders or gradients, and no more than one primary (accent) button on screen: Export.
2. **Color carries meaning, never decoration.** The accent `--vis-accent` means *selected / primary*. Track colors only tell tracks apart. Warning / danger colors only show state (new version, conflict, invalid drop).
3. **Direct manipulation first.** Everything common (move, trim, split, fade) works on the clip itself. The inspector exists for exact values, not as the only way in.
4. **Never lose work silently.** Save state is always visible, and conflicts stop the user rather than overwrite (0024 §2).
5. Theme variables only (`--vis-*`). Icons are inline SVG in the `ui-kit` icon style (1.5 px stroke, 16 px box). No new dependencies.

## 2. Shell and layout

Full-screen layer from the same family as the 0019 lightbox, but on an opaque `--vis-bg`: this is a workspace, not a peek. It opens with a 180 ms fade + 0.98→1 scale from the node, Esc closes it (after flushing a pending save), and focus returns to the timeline node on the canvas.

```
┌ Header 48 ──────────────────────────────────────────────────────────────────┐
│ ←  Rough cut v2 ✎   00:42.10 · 1920×1080 · 30fps   ● Saved     [⋯] [Export] │
├ Media bin 240 ─┬──────────── Preview ────────────────┬─ Inspector 280 ──────┤
│ [Video|Image|  │                                      │ Clip                 │
│  Audio] search │          16:9 frame on #000          │ Source  Shot 3 ↗     │
│ ┌──┐┌──┐┌──┐   │                                      │ In  00:01.20         │
│ │  ││  ││  │   │                                      │ Out 00:04.80         │
│ └──┘└──┘└──┘   │  ▶  ‹ ›   00:12.04 / 00:42.10   ⛶   │ Volume ───●── 100%   │
│                │                                      │ Fade in / out        │
├────────────────┴────────────────═══ splitter ═════════┴──────────────────────┤
│ Toolbar 36:  ✂ Split  🗑 Delete │ ⊓ Snap │ + Audio track │   − ──●── + Fit │
│ Ruler 24     0s        5s        10s        15s        20s        25s       │
│ ▣ Video  🔊─ │▓▓▓▓▓▓▓│▓▓▓▓▓▓▓▓▓▓│▓▓▓▓│▓▓▓▓▓▓▓▓│          ▼ playhead        │
│ ♪ Music  🔊─ │ ╱▁▃▅▇▅▃▅▇▅▃▁▃▅▇▅▃▁▃▅▇▅▃▁▃▅▇▅▃╲ │                             │
│ ♪ SFX    🔊─ │      ▃▅▃      ▅▇▅         ▃▅▃                                 │
└──────────────────────────────────────────────────────────────────────────────┘
```

- **Header** (48 px, `--vis-panel`, bottom border `--vis-panel-border`). Left: back arrow (closes), node title editable in place (same component as the 0021 title row). Middle (`--vis-text-dim`, mono for numbers): total duration · output size · fps; clicking it opens the output popover (size presets 1080p / 720p / 4K / vertical 1080×1920 / square, plus "Match first clip"). Right: save state, `⋯` menu (download latest export, open latest export on canvas, version history), **Export** (the only accent button).
- **Save state** (12 px, dot + text): `Saved` (dot `--vis-ok`), `Saving…` (dot `--vis-text-faint`, pulsing; static under reduced motion), `Unsaved changes` (dot `--vis-warn`, shown only while a commit is retried), `Conflict` (dot `--vis-danger`, clicking it opens the banner, §6).
- **Media bin** (240 px, collapsible to a 44 px icon rail, auto-collapsed below 1280 px window width). Segmented filter Video / Image / Audio / All, a search field, and a two-column grid of the project's media nodes (16:9 thumbnail, title, duration chip; audio shows a mini waveform). Nodes already used in this timeline show a small check badge. Drag a card onto a track to add it; double-click appends it to the end of the video track (video / image) or at the playhead on the first free audio track (audio).
- **Preview**: the output frame letterboxed on `#000` inside a `--vis-bg` area, aspect from `output`. Transport bar under it (40 px): play / pause, previous / next frame, timecode `00:12.04 / 00:42.10` (mono, tabular numbers, the current time is editable: click, type, Enter seeks), and fullscreen preview on the right.
- **Inspector** (280 px). With a clip selected it shows the clip (§5). With nothing selected it shows the timeline: output settings and track list summary. It is never empty.
- **Timeline area**: default 34 % of the height (fits the video track and three audio tracks at 1000 px; the preview gets the rest), splitter-resizable between 200 px and 70 %; the size is remembered in localStorage `vis.timeline.split`.
- **Minimum window** 960 × 600. Below 1100 px the inspector becomes an overlay sheet that opens on selection.

## 3. Timeline

### 3.1 Structure and sizes

| Part | Size | Notes |
|---|---|---|
| Toolbar | 36 px | Left: Split, Delete, divider, Snap toggle, Add audio track. Right: zoom slider and Fit |
| Ruler | 24 px | Labels in `--vis-text-faint` 11 px mono; tick density follows zoom (frames → 1 s → 5 s → 30 s → 1 min) |
| Track header | 168 px wide | Icon, editable name, mute toggle, volume slider shown on hover / focus; drag handle for audio track order |
| Video track | 64 px | Filmstrip clips |
| Audio track | 48 px | Waveform clips |
| Gap between tracks | 4 px | No row borders; alternating is not used |

The header column and ruler are sticky; tracks scroll horizontally together. A thin end-of-timeline marker (`--vis-border-strong`, dashed) shows the total duration.

### 3.2 Clip visuals

- Shape: `--vis-radius-sm` corners, 1 px inner gap between neighboring video clips so cuts stay readable.
- **Video / image clips**: filmstrip sprite (`media.preview` filmstrip) as the background, tiled by `background-position`, with a bottom gradient to `rgb(0 0 0 / 55%)` behind the label. Image clips repeat the single frame and show a small image icon.
- **Audio clips**: fill = track color at 18 % alpha, 1 px border = track color at 45 %, waveform bars in the track color at 85 % (bars, not a line, matching the audio node reference). The video track's own soundtrack is not drawn as a separate lane in 0024b; a speaker icon on the clip shows whether it has audio and its volume when not 100 %.
- **Track colors** (from the existing frame palette): first audio track `--vis-frame-teal` (music), second `--vis-frame-amber` (SFX), third `--vis-frame-violet` (voice), fourth `--vis-frame-blue`. The color follows the track position, not its name. Video clips use no track color.
- **Label** (11 px, `--vis-text`, single line, ellipsis): source node title; duration appears on hover. Hidden when the clip is narrower than 48 px.
- **Badges** (top right, 14 px): *new version available* = small dot `--vis-warn` (tooltip + action in the inspector); *source node deleted* = broken-link icon `--vis-text-faint`, the clip still plays.
- **Fades**: a translucent dark ramp over the clip's top corner, with a 8 px round handle at the ramp end, visible on hover / selection. Dragging the handle sets the fade; a tooltip shows the length.
- **Muted track**: its clips drop to 40 % opacity and the waveform turns `--vis-text-faint`.
- **Selection**: 2 px `--vis-accent` outline drawn inside the clip, plus trim handles (6 px wide grips at both edges, `--vis-accent`). Multi-select (Shift / Cmd-Ctrl click, or marquee drag on empty track space) outlines every selected clip.
- **Playhead**: 1 px `--vis-text` line through all tracks, with a 10 px `--vis-accent` head in the ruler that can be dragged. Clicking the ruler seeks.

### 3.3 Interactions

- **Move**
  - Video track: dragging lifts the clip (ghost at 70 % opacity) and shows an insertion caret (2 px `--vis-accent` bar) between clips; on drop the others close up / open up. No gaps can exist (0024 §1).
  - Audio tracks: free positioning, and a clip can move to another audio track. Hovering a position that would overlap marks the ghost with a `--vis-danger` outline; dropping there returns it to where it was.
  - Media of the wrong kind cannot drop on a track (video track takes video / image, audio tracks take audio / video-as-soundtrack); the track shows a `not-allowed` cursor.
- **Trim**: drag a clip edge (`ew-resize` cursor). Tooltip shows the new in / out and the clip length. On the video track trimming ripples the following clips. Trimming stops at the source bounds and at the image display range (0.5–30 s); hitting a bound shows a brief `--vis-warn` flash on the edge.
- **Snap** (on by default, toolbar toggle, hold Alt to bypass while dragging): to the playhead, clip edges on any track, 0 and the timeline end, within 8 px. An active snap draws a full-height dashed `--vis-accent` guide.
- **Split** at the playhead on the selected clips, or on every clip under the playhead if nothing is selected (S, or the toolbar). **Delete** removes selected clips; on the video track the rest close up.
- **Duplicate**: Cmd/Ctrl+D places a copy right after the clip (video) or on the next free space of the same audio track.
- **Zoom**: Cmd/Ctrl + wheel or pinch around the pointer; the slider; Fit shows the whole timeline. Plain wheel scrolls vertically when there are more tracks than fit, Shift + wheel scrolls horizontally, a trackpad scrolls in both directions.
- **Context menu** on a clip: Split here, Duplicate, Delete, Use new version (when available), Show source on canvas, Mute clip audio.
- **Undo**: Cmd/Ctrl+Z / Shift+Cmd/Ctrl+Z inside the editor walk local edits, including ones already committed (each committed edit is one canvas undo step, 0024 §2).

### 3.4 Keyboard

| Key | Action |
|---|---|
| Space | Play / pause |
| ← / → | Previous / next frame; with Shift ±1 s |
| Home / End | Timeline start / end |
| S | Split |
| Delete / Backspace | Delete selected clips |
| Cmd/Ctrl+D | Duplicate |
| Alt+← / Alt+→ | Nudge selected audio clips by one frame |
| Tab / Shift+Tab | Move selection to the next / previous clip on the same track |
| Cmd/Ctrl+= / − / 0 | Zoom in / out / fit |
| Esc | Clear selection; with no selection, close the editor |

Shortcuts are ignored while a text field has focus.

## 4. Preview

- Behavior follows 0024 §6 (two alternating `<video>` elements, `<audio>` per sounding clip, WebAudio gains, `AudioContext` clock).
- While the timeline is scrubbed, the preview shows the frame under the playhead (seek only, no audio). A short "Loading…" spinner appears only if a frame takes longer than 300 ms.
- Over gaps in audio-only timelines the preview shows a centered audio glyph and the current audio clip names; for an empty timeline it shows the empty state (§7).
- Fullscreen preview hides everything else and keeps the transport bar, which auto-hides after 2 s without pointer movement.

## 5. Inspector

Clip section (fields commit on blur / Enter, one commit each):

- Source: node title with ↗ (focuses the node on the canvas after closing the editor), and the pinned version ("v3"). When a newer version exists: a `--vis-warn` notice "A newer version of this node exists" with **Use new version**.
- In / Out / Length: timecode inputs (mono). Editing Length moves Out.
- Clip volume: slider 0–200 % with the value field; 100 % has a detent. For video clips the label is "Clip audio".
- Fade in / Fade out: number fields in seconds plus the same handles as on the clip.
- Footer: Delete clip (text button, `--vis-danger` text, no fill).

Timeline section (nothing selected): output size / fps (same as the header popover), the track list with mute and volume, and the latest export (thumbnail, "Exported 3 min ago", "Out of date" chip if the timeline changed afterwards).

## 6. Save, conflict and export states

- Commits follow 0024 §2 (pointer-up or 500 ms after typing stops). While a commit is in flight, further edits stay local and are committed together.
- **Conflict banner**: a 40 px strip at the top of the timeline area, `--vis-warn` at 14 % alpha, text "This timeline was changed by ⟨session name⟩." with **Load their version** and **Show differences**. The differences popover lists added / removed / changed clips with their track and time; clicking an item scrolls to it. Editing is disabled (tracks dimmed to 60 %) until the user loads the new version; there is no force-overwrite.
- **Export button** states: idle "Export"; running: the button becomes a progress pill "Exporting 42 %" with a cancel ×, and the rest of the editor stays usable; done: a toast "Exported · Show on canvas"; failed: a toast with the localized reason and **Retry**. A running export started by an Agent shows the same pill with the session name in the tooltip.
- Edits made during an export do not affect it (0024 §7); the latest export simply turns "Out of date".

## 7. Empty and edge states

| State | What the user sees |
|---|---|
| New empty timeline | Video track and one "Music" track with dashed drop zones; centered hint in the timeline: "Drag videos, images or audio here from the media bin or the canvas" |
| Empty media bin | "No media in this project yet" + Upload button (existing upload flow) |
| Source node deleted | Clip keeps playing; broken-link badge; inspector says "The source node was deleted. The clip still uses its saved media." |
| Asset missing / unreadable | Clip shows a diagonal-stripe `--vis-danger` 20 % pattern and "Media unavailable"; export will fail with its reason code |
| Agent is editing | A small chip in the header "⟨session⟩ is editing" while that session's turn is running and it last wrote this node; edits still allowed (conflicts handled by §6) |

## 8. Motion

- Ripple shifts, insertion caret and drop return animate 120 ms ease-out; panel collapse 160 ms; editor open 180 ms.
- Under `prefers-reduced-motion: reduce`: no ripple / drop animations (positions jump), open / close is a 80 ms fade, the save dot does not pulse, and playback does not auto-scroll the timeline smoothly (it pages instead).

## 9. Performance rules for implementers

These serve the 0024 §8 budgets (open < 500 ms with 50 clips, 60 fps with 200 clips):

- Render only clips intersecting the visible time window plus one screen on each side.
- The playhead and the preview clock update through `requestAnimationFrame` and CSS `transform`, never through React state per frame.
- During drag / trim, update one transient position object and render the ghost and caret from it; the document is rebuilt and committed on pointer-up only.
- Waveforms: one `<canvas>` per visible audio clip, drawn from cached `peaks` for the visible slice only, redrawn on zoom with a 100 ms debounce (show the stretched previous bitmap meanwhile). Filmstrips are CSS background sprites, no per-frame `<img>`.
- Fetch previews lazily per asset version and keep them in a module-level cache shared with the canvas.

## 10. Accessibility and e2e hooks

- The timeline is a `role="application"` region labelled "Timeline". Each track is a `role="group"` with `aria-label` = track name. Each clip is a focusable button: `aria-label="⟨title⟩, ⟨start⟩–⟨end⟩"`, `aria-selected` when selected.
- Controls carry visible text or `aria-label`: "Play", "Pause", "Split", "Delete", "Snap", "Add audio track", "Zoom", "Fit", "Export", "Load their version", "Show differences", "Use new version", "Close editor". e2e selects by these, never by `data-testid`.
- Focus rings use `--vis-focus` (2 px). Color is never the only signal: badges have icons and tooltips, conflict and invalid drops have text.

## 11. Copy

All strings live in `packages/timeline/ui/src/messages.ts` (Chinese and English via `defineMessages`); durations and times go through `useFormat()` plus a timecode formatter (`mm:ss.ff`, hours shown only when needed).

| Key | 中文 | English |
|---|---|---|
| `export` | 导出 | Export |
| `exporting` | 导出中 {percent}% | Exporting {percent}% |
| `saved` / `saving` / `unsaved` / `conflict` | 已保存 / 保存中… / 有未保存的修改 / 有冲突 | Saved / Saving… / Unsaved changes / Conflict |
| `conflictBanner` | 剪辑已被 {session} 修改。 | This timeline was changed by {session}. |
| `loadTheirs` / `showDiff` | 载入新版本 / 查看差异 | Load their version / Show differences |
| `newVersion` / `useNewVersion` | 源节点有新版本 / 换成新版本 | A newer version of this node exists / Use new version |
| `sourceDeleted` | 源节点已删除，片段仍使用保存的素材。 | The source node was deleted. The clip still uses its saved media. |
| `emptyTimeline` | 从素材栏或画布拖入视频、图片或音频 | Drag videos, images or audio here from the media bin or the canvas |
| `outOfDate` | 未导出的修改 | Out of date |
| track defaults | 视频 / 配乐 / 音效 / 配音 / 音轨 {n} | Video / Music / Sound effects / Voice / Audio {n} |

## Decisions

- The video track's own soundtrack gets no separate lane in 0024b: a speaker icon on the clip plus the inspector's "Clip audio" slider (confirmed 2026-11-01).
- Visuals were signed off on a static high-fidelity mockup (1600×1000) on 2026-11-01, with the timeline height lowered from 42 % to 34 %. The mockup lives outside the repo; implementers follow this spec.
- Implementation notes for 0024b (2026-11-01), overriding the sections above where they differ:
  - Media enters the timeline from the media bin only; the empty-timeline copy no longer mentions the canvas. There is no export cancel and no "Agent is editing" chip.
  - Undo / Redo are keyboard-only (Ctrl / Cmd+Z, Shift+Ctrl / Cmd+Z). Esc closes an open popover first, then clears the selection, then closes the editor.
  - Fade fields are "Fade in (seconds)" / "Fade out (seconds)" and take decimal seconds. The volume slider has a numeric percent field beside it ("Clip volume (percent)" / "Clip audio (percent)").
  - Without `doc.output`, the header shows "Match first clip" instead of an fps, and timecodes use 30 fps.
  - The latest export shows "Exported from r<n>" instead of an age; pinned versions show as `v<n>`.
  - Clip labels sit on a translucent chip so they stay readable over waveforms and filmstrips.

## Implementation audit (2026-11-05)

The shell, media bin, preview/fullscreen transport, resizable timeline, inspector, revision-safe drafts/conflicts and export feedback are implemented in `packages/timeline/ui/src/`. The `timeline-editor.e2e.ts` suite covers editing and persistence; text, speed, script assembly and overlays have separate e2e suites. The Decisions above and the later 0024 implementation notes override the original mockup where they differ.

Concrete shipped differences from the original layout: the full-screen shell is an accessible modal dialog containing a timeline application region; the inspector starts closed and opens on clip selection; export has progress but no cancel action or Agent-editing chip; media is added through the bin. No implementation work is being claimed for the real minimum-spec machine, Windows LGPL build or deferred Claude Code d/e acceptance. See 0024's final audit for the complete follow-up list.
