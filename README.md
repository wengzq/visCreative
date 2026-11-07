<p align="center">
  <img src="docs/images/banner.svg" alt="visCreative — a multi-agent creative space on an infinite canvas" width="100%">
</p>

<p align="center">
  <b>English</b> · <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <img alt="Node.js 24+" src="https://img.shields.io/badge/node-%E2%89%A524-3c873a?logo=nodedotjs&logoColor=white">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5.9-3178c6?logo=typescript&logoColor=white">
  <img alt="React 19" src="https://img.shields.io/badge/React-19-149eca?logo=react&logoColor=white">
  <img alt="SQLite" src="https://img.shields.io/badge/SQLite-source%20of%20truth-0f80cc?logo=sqlite&logoColor=white">
  <img alt="pnpm" src="https://img.shields.io/badge/pnpm-10-f69220?logo=pnpm&logoColor=white">
  <img alt="Tests" src="https://img.shields.io/badge/tests-2900%2B%20unit%20%C2%B7%20299%20e2e-2ea44f">
  <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue">
</p>

<p align="center">
  Your taste, every tool an Agent can bring.<br>
  A shared canvas where Agents write, draw, render and edit alongside you, through real interfaces. Everything is versioned and traceable, and what counts as good stays yours to decide.
</p>

---

<p align="center">
  <img src="docs/images/en/hero.webp" alt="The visCreative web UI: a shared canvas with a script node, illustrated key frames (one selected with its version strip and node toolbar), a timeline node, and a Codex session on the right" width="100%">
</p>

## Principle

**Mechanism belongs to the product, proposals to the Agent, decisions to the author.** visCreative builds the foundations of creation and connects Agents to them. Taste and judgement stay with you: they are what separates excellent work from ordinary work.

- **Agents offer, you choose.** On open creative choices an Agent brings distinct directions with reasons, not one best answer.
- **Your work stays yours.** Agents propose edits to what you wrote and cannot replace what you drew. Deleting your text or cleaning up their own child workspaces takes your click. The gateway enforces this, not a prompt.
- **No fixed way of working.** The shot table, the previz step and every other workflow are options you can skip.
- **Nothing is inferred behind your back.** What counts as good is yours to define: tell an Agent how you work, read the draft, and save it as your own skill.

## Highlights

|  |  |
| --- | --- |
| 🧑‍🤝‍🧑 **Multi-agent, one canvas** | Run several agent sessions side by side (Codex and DeepSeek Harness; Claude Code is selectable, with real-Agent acceptance still open) on the same space. Each session has its own transcript; the canvas is shared. |
| ✍️ **A place to write** | Open any text node as a full manuscript page: chapter outline, Obsidian-style live preview, rendered and editable tables, autosave with version history, and TXT, Markdown and DOCX import. Agents leave anchored suggestions for you to accept or reject, and a selection or chapter can become shots that stay linked to the source text. |
| 🧍 **Interactive 3D scenes** | Stage a shot before generating it: place posable figures, props and your own `.glb` models, keep named camera views, then save a view as an image or send it to a previz panel. Rotate joints within their limits, start from a preset pose, or mirror one side to the other. Scenes stand alone and are optional. |
| 🎥 **Shot previz** | Sketch panels with a pressure-sensitive pen or import your own, several per shot, then ask an Agent for a free grey-model blockout rendered with code. Previz and paid generation are separate stages: a blockout's frames become composition references only when you say so. |
| 🧠 **Your skills, your way** | Tell an Agent how you work and it drafts a skill in your words. You edit and save it; versions are immutable, each project keeps a pinned copy, and you decide when to update, publish, reset or add it to new projects. |
| 💬 **Conversations you can read** | Thinking and tool calls fold into one work block per stretch of activity, generated images and video appear as result cards, and **Send now** moves a queued message ahead of the running turn. |
| 🗂️ **Work items and a board** | Hand a goal to an agent in a root workspace and it splits it into child work items, each with its own directory and agent sessions. Canvas nodes and assets stay shared across the project. Progress shows up on a To do / In progress / In review / Done board; questions land in a cross-project inbox; you review each item's changes before it counts as done. The board is yours: drag any card to any column, no reasons asked. |
| 🗑️ **Recently deleted projects** | Delete a project from its switcher menu to stop its agents and jobs while keeping canvas, history and files recoverable in Settings → Recently deleted. Permanent deletion removes application data; deleting the project directory is a separate, unchecked option with directory safety checks. |
| 🧭 **Agents work through a real API** | Every capability is declared once in a protocol registry and exposed to agents as the `vis` CLI and an MCP server. Canvas and database changes go through the API; isolated Codex sessions can also work with files in their workspace. |
| 🎞️ **Generation that comes back home** | Jobs are idempotent and survive restarts. Results are delivered into the exact canvas slot they were meant for, with revision checks so nothing silently overwrites newer work. |
| 🕰️ **Nothing generated is ever lost** | Every slot keeps its full revision history. Hover to peek at an old version, click to compare, then restore it or save it as a new node — without paying to regenerate. |
| 🔗 **Provenance you can see** | Dashed edges show which nodes a result was generated from; solid edges show the references a generation node will use next. |
| ↩️ **Undo that respects others** | Your own canvas edits are undoable (and survive reloads). If an agent or a delivery changed the same thing since, the step is refused instead of clobbering their work. |
| 🎨 **Real providers, safely** | Built-in mock and local code rendering (HTML/anime.js/three.js → image or video), plus Volcengine Ark, Kling, OpenAI Images, Alibaba Wan (DashScope), MiniMax and Gemini. Ark is verified against its real API; the others are marked unverified in the app until they pass acceptance. API keys live only in the macOS Keychain or Windows Credential Manager. |
| 🎬 **From script to finished cut** | A script node holds the whole shot table with its cast; generate first frames and videos per shot, then **Assemble timeline** and edit in a full-screen editor: trims, speed, transitions, captions, logo and picture-in-picture overlays, music. Export renders a regular video node through ffmpeg. |
| 🎵 **Audio on the canvas** | Upload audio, play and seek through waveform nodes, or generate mock music and sound effects. Audio uses the same version history, reference inputs and generation workflow as images and video. |
| 📚 **Asset library** | Open **Library** in the top bar to browse the project's media by kind, category and tag. On request, the project's library session names, categorizes and tags media (your edits always win, every run can be undone) and proposes grouping media of one subject into settings — characters, scenes, props and styles — which you review before they count. Drag media onto the canvas; cast settings into scripts from the script editor. Make a project an episode of a series to share settings across episodes: each episode keeps its own pinned copy and updates only when you choose. |
| 🖱️ **A canvas that feels like a tool** | Floating prompt panel with model and parameter pickers, quick-extend ⊕ buttons, right-click menu, copy/paste/duplicate, download, minimap, collapsible session panel. |

## A closer look

A sample production, the animated series “Mountain & Sea”, episode 1 “First Light”. Every picture was rendered locally and every agent turn is scripted; `pnpm --filter @vis/web readme-shots` reproduces these screenshots (see [Development](#development)).

<table>
  <tr>
    <td colspan="2"><img src="docs/images/en/writing.webp" alt="The manuscript page for First Light, with a chapter outline, live Markdown preview and a rendered three-column table"></td>
  </tr>
  <tr>
    <td colspan="2" align="center"><sub><b>A place to write</b> — A chapter outline, live preview and editable tables keep the manuscript in one place. Open any text node to write.</sub></td>
  </tr>
  <tr>
    <td colspan="2"><img src="docs/images/en/writing-review.webp" alt="An anchored Agent suggestion in the opening paragraph, with the original wording, proposed replacement and Accept and Reject controls"></td>
  </tr>
  <tr>
    <td colspan="2" align="center"><sub><b>Suggestions, your decision</b> — Agents leave edits beside the passage they refer to. Your words change only when you accept.</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/images/en/previz.webp" alt="A shot previz canvas card with two drawn panels, blockout composition markers and a local grey-model blockout row"></td>
    <td width="50%"><img src="docs/images/en/previz-editor.webp" alt="The full-screen panel editor showing a drawn mountain ridge, a figure holding a lantern, two panels and camera notes"></td>
  </tr>
  <tr>
    <td align="center"><sub><b>Shot previz</b> — Sketch several panels per shot. Review a free local blockout, then choose whether its frames become composition references.</sub></td>
    <td align="center"><sub><b>Panel editor</b> — Draw, import, reorder and add camera notes in a full-screen workspace. Your drawings stay under your control.</sub></td>
  </tr>
  <tr>
    <td colspan="2"><img src="docs/images/en/scene-editor.webp" alt="The 3D scene editor: a figure in a pointing pose with the rotate gizmo on its selected right shoulder, and preset, mirror and joint controls in the inspector" /></td>
  </tr>
  <tr>
    <td colspan="2" align="center"><sub><b>3D scenes</b> — Stage figures, props and camera views, then save a frame as an image or send it to a previz panel.</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/images/en/skills.webp" alt="Settings My skills with a saved storytelling skill and its project copy marked Newer version available and Edited here"></td>
    <td width="50%"><img src="docs/images/en/skill-draft.webp" alt="An Agent session with the author’s storytelling method and a pending Skill draft card offering Review and Discard"></td>
  </tr>
  <tr>
    <td align="center"><sub><b>My skills</b> — Save your method and keep a pinned copy in each project. Update, reset or publish a local refinement when you choose.</sub></td>
    <td align="center"><sub><b>From conversation to skill</b> — Ask an Agent to draft the method you described. Review the draft before it joins your skills.</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/images/en/turn-view.webp" alt="A session work block followed by a locally rendered lantern video result and a queued message with Send now"></td>
    <td width="50%"><img src="docs/images/en/cleanup-card.webp" alt="A child-workspace cleanup approval card naming the sound and edit work items, their consequences and Delete and Keep buttons"></td>
  </tr>
  <tr>
    <td align="center"><sub><b>Readable turns</b> — Work stays folded, results stay visible, and Send now lets your next direction interrupt the current turn.</sub></td>
    <td align="center"><sub><b>Cleanup needs your click</b> — An Agent can request cleanup of its child workspaces. You decide; canvas content and assets stay.</sub></td>
  </tr>
  <tr>
    <td colspan="2"><img src="docs/images/en/script.webp" alt="The script editor: five shots with durations, transitions, descriptions, shot sizes, camera moves, cast and scene"></td>
  </tr>
  <tr>
    <td colspan="2" align="center"><sub><b>Script</b> — one node holds the whole shot table. Cast characters and scenes from the library; the owning agent writes first-frame and video prompts, and batch generation fills in every shot.</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/images/en/script-cast.webp" alt="Storyboard settings: character reference images, descriptions and per-shot usage"></td>
    <td width="50%"><img src="docs/images/en/script-prompts.webp" alt="Storyboard prompts: separate first-frame and video prompts for each shot"></td>
  </tr>
  <tr>
    <td align="center"><sub><b>Reference settings</b> — Keep characters, descriptions and reference images together.</sub></td>
    <td align="center"><sub><b>Shot prompts</b> — First-frame and video prompts stay with each shot.</sub></td>
  </tr>
  <tr>
    <td colspan="2"><img src="docs/images/en/timeline.webp" alt="The full-screen timeline editor: media bin, a preview with a caption and the series emblem, and tracks for captions, an emblem overlay, video clips and music"></td>
  </tr>
  <tr>
    <td colspan="2" align="center"><sub><b>Timeline editor</b> — captions, a logo overlay, clips at 1.5× with crossfades, and music with a waveform. The preview matches the export.</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/images/en/timeline-assemble.webp" alt="A script node connected to a timeline node, which is connected to its exported video"></td>
    <td width="50%"><img src="docs/images/en/timeline-inspector.webp" alt="A selected video clip in the timeline with the inspector showing in/out points, speed presets, clip volume and fades"></td>
  </tr>
  <tr>
    <td align="center"><sub><b>Script → timeline → video</b> — Assemble timeline takes the latest video of each shot; the export lands back on the canvas as a regular video node.</sub></td>
    <td align="center"><sub><b>Clip inspector</b> — trim, speed with preserved pitch, volume and fades for the selected clip.</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/images/en/library-media.webp" alt="The library panel's media tab: audio, images and videos grouped by kind and category, with tag filters"></td>
    <td width="50%"><img src="docs/images/en/library-settings.webp" alt="The library's settings tab: two characters with series version, new series version and modified locally badges, and a series setting not used in this episode"></td>
  </tr>
  <tr>
    <td align="center"><sub><b>Library media</b> — the library session names, categorizes and tags media on request; your edits always win.</sub></td>
    <td align="center"><sub><b>Settings and series</b> — each episode keeps a pinned copy of the series' characters, scenes and styles, and updates only when you choose.</sub></td>
  </tr>
  <tr>
    <td colspan="2"><img src="docs/images/en/board.webp" alt="The work board: a director work item and its children across To do, In progress, In review and Done; one agent is waiting for a reply"></td>
  </tr>
  <tr>
    <td colspan="2" align="center"><sub><b>Work board</b> — the director dispatched four tasks: one waits for your answer, one is ready for review, one is done. Execution slots are shared across projects.</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/images/en/review.webp" alt="The review drawer for a work item: the agent's completion report and before/after previews of the changed key frame"></td>
    <td width="50%"><img src="docs/images/en/inbox.webp" alt="The inbox: an agent's question with a reply box and a completion report with a Review button"></td>
  </tr>
  <tr>
    <td align="center"><sub><b>Review drawer</b> — the agent's report and every node it created or changed this round. Approve, or send it back with optional notes.</sub></td>
    <td align="center"><sub><b>Inbox</b> — reports and questions from every project in one place; reply right there, or open the review.</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/images/en/versions.webp" alt="Viewing an older version of a key frame, with Set as current and Save as node actions and the node toolbar"></td>
    <td width="50%"><img src="docs/images/en/context-menu.webp" alt="Right-click menu on an image node"></td>
  </tr>
  <tr>
    <td align="center"><sub><b>Version history</b> — peek, compare, restore or branch off any past result.</sub></td>
    <td align="center"><sub><b>Right-click menu</b> — categorize, create a timeline, copy, duplicate, send to an agent, generate with it as reference, download.</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/images/en/series.webp" alt="The project switcher listing two episodes grouped under the Mountain & Sea series"></td>
    <td width="50%"><img src="docs/images/en/providers.webp" alt="Generation service settings with a demo Volcengine Ark entry, model IDs and a saved key status"></td>
  </tr>
  <tr>
    <td align="center"><sub><b>Series</b> — episodes are grouped under their series in the project switcher.</sub></td>
    <td align="center"><sub><b>Generation services</b> — add a service by type, pick its region and models in the app; keys go straight to the system credential store and are never shown again.</sub></td>
  </tr>
</table>

## How it works

```mermaid
flowchart LR
  subgraph Browser
    UI["Web UI<br/>canvas · sessions · settings"]
  end
  subgraph Host["Web host (127.0.0.1)"]
    WH["token + Host/Origin checks<br/>asset streaming · uploads"]
  end
  subgraph Daemon["studiod — local daemon"]
    GW["Gateway<br/>JSON-RPC over a unix socket"]
    CV["Canvas core<br/>nodes · slots · revisions · undo"]
    WB["Workbench<br/>spaces · sessions · agent runtimes"]
    WK["Work items<br/>dispatch · slots · inbox · review"]
    GEN["Generation<br/>jobs · retries · delivery"]
    DB[("SQLite per space<br/>+ content-addressed blobs")]
  end
  subgraph Agents
    CX["Codex<br/>codex app-server"]
    DS["DeepSeek Harness<br/>dsh --profile acp"]
    CC["Claude Code"]
  end
  subgraph Providers
    MK["Mock"]
    RD["Local render<br/>HTML/anime.js/three.js → media"]
    CLOUD["Cloud services<br/>Ark · Kling · OpenAI<br/>DashScope · MiniMax · Gemini"]
  end

  UI <-- WebSocket --> WH <--> GW
  GW --> CV & WB & GEN & WK
  CV & WB & GEN & WK --> DB
  WK -- "briefs · replies · feedback" --> WB
  WB -- spawns --> CX & DS & CC
  CX & DS & CC -- "vis CLI / MCP" --> GW
  GEN --> MK & RD & CLOUD
  GEN -- "deliver into slot" --> CV
```

**The loop, end to end:** you reference a few nodes and message an agent → the agent reads them with `canvas.get` → it calls `generation.submit` with a target slot → studiod runs the job against a provider and, when it finishes, writes the result into that slot as a new revision → every connected window receives a `slot.revised` event and the canvas updates in place.

**With work items:** any session in a root workspace calls `work.dispatch` to create direct child items → child agents share the project canvas and call `work.report` (`question`, `blocked` or `done`) → reports go to the parent workspace’s first unarchived session (oldest `createdAt`, then ID) and your inbox; a `done` moves the card to In review → you approve or send it back. Sessions have no coordinator/worker/chat roles. Execution slots are global (6 by default); full slots queue activations across projects. Recall stops work and keeps the item available to resume. User-only deletion stops and removes the item and its children and archives their sessions; work directories and every canvas node are kept. This round’s changes come from the work item’s own session events, with a distinct-node `changeCount` and per-node `lastSeq` ordering.

If a child finishes its turn after a dispatch, reply or review feedback without reporting, its parent receives one notice per delivered batch, including the last 500 characters of the child's reply and any unfinished generation count. Nothing is stopped or moved. The card warns until another child turn starts or it reports. These notices wake the parent at most twice; later notices stay in your inbox. A report or your own action on the card, such as activating or recalling it, resets the count. The parent's own recall and activation do not. The parent can reply without `replyTo`, recall the child or keep waiting.

The session panel folds each stretch of thinking, plans and tool calls into one work block that shows elapsed time and tool counts, and expands to the full steps. Generated results stay visible outside the block as cards you can preview, locate or reference. Reasoning and plan availability depend on the agent adapter.

Sessions have their own model and reasoning effort selectors in the composer. Options come from the Agent; “Default” keeps Agent defaults. Unsupported effort resets when switching models, and changes during a running turn apply to the next turn.

A few principles hold everything together:

- **One capability registry.** `packages/protocol` declares every method with its schema, its callers (`ui`, `agent`) and its documentation. The CLI, the MCP server and `capabilities.describe` are all generated from it.
- **SQLite is the source of truth.** Each space is a single `space.db` plus immutable, content-addressed blobs. Content writes are optimistic (`expectedRevision`); layout writes are last-write-wins.
- **Expensive things are never repeated by accident.** When a provider times out and we can't tell whether it accepted the job, the job goes to `unknown` instead of being re-submitted.
- **Strict module boundaries.** UI packages only depend on the protocol; the canvas and workbench cores never import each other and cooperate through ports. `scripts/check-boundaries.mjs` enforces this as part of `pnpm check`.

## Quick start

**Requirements:** Node.js 24+, pnpm 10 (via Corepack), `ffmpeg`/`ffprobe` 7 or newer on `PATH`, Google Chrome (for local rendering and e2e tests). To chat with agents you need [Codex](https://github.com/openai/codex) and/or DeepSeek Harness (`dsh`) installed and logged in; visCreative only launches them and never opens their credential files. DeepSeek installed by `npx @deepseek-ai/dsh web` is also discovered automatically; a global install is not required. Run it once yourself to install and sign in. visCreative never downloads dsh automatically.

For the Windows 11 x64 toolchain, install Python 3 and Visual Studio Build Tools with the C++ desktop workload before installing dependencies: better-sqlite3 13.x builds locally. Install ffmpeg as well, then reopen the terminal so its `PATH` is refreshed:

```powershell
winget install Microsoft.VisualStudio.2022.BuildTools --override "--quiet --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
winget install Gyan.FFmpeg
```

The shared lockfile covers macOS, Linux and Windows on x64/arm64; this does not imply runtime support for every architecture. Windows 11 x64 is supported (RFC 0022): studiod listens on a named pipe, keys go to Credential Manager, Codex and dsh launch without a shell, and agents get a runtime `vis.cmd`. On Windows, also install Visual Studio Build Tools (C++ desktop workload) for better-sqlite3, ffmpeg (`winget install Gyan.FFmpeg`), and turn on Developer Mode so the symlink security tests can create links. Local rendering and browser e2e accept `VIS_CHROME_PATH`; otherwise they discover Chrome or Edge on Windows and retain the existing Chrome location on macOS.

```sh
corepack enable
pnpm install
pnpm fonts:fetch   # bundled caption fonts (OFL), verified by SHA-256 and not committed

# terminal 1 — the daemon (data in ~/.vis-dev, override with VIS_DATA_DIR)
pnpm dev:studiod

# terminal 2 — the web UI; open the printed http://127.0.0.1:…/#t=… link
pnpm dev:web
```

On macOS, Codex and dsh run inside an outer sandbox: workspace writes and network are allowed; generation keys, application tokens and databases are blocked. Each agent can read and write its own configuration directory (including its own credentials: `CODEX_HOME` or `~/.dsh`), but not another agent's (`~/.codex`, `~/.dsh`, `~/.claude`, `~/.claude.json`). Windows allows commands and writes without an isolation sandbox; only use agents in projects you trust. Other unsupported systems keep read-only tools.

There is also a terminal client for driving the same loop without a browser: `pnpm dev:client` (type `/help`).

### Local rendering and author libraries

Local rendering includes MIT-licensed anime.js 4.5.0 at `/lib/anime.js`, plus rough.js and three.js. Plain JavaScript is an equal option. Pages stay offline and expose `window.vis.seek(t)` in seconds; anime.js timelines must be paused and convert `t` to milliseconds.

To use another library, create `<dataDir>/render-libs/` yourself (`~/.vis-dev/render-libs/` in development) and place its browser JavaScript file directly inside. Names must match `^[A-Za-z0-9._-]+\.js$`; for example, `helper.js` is served at `/lib/helper.js`. Subdirectories and symlinks escaping this folder are refused. Built-in `anime.js`, `rough.js` and all `three*` names are reserved. Files are reread when rendering, so adding or replacing a library needs no daemon restart. Keep the application data directory outside project and Agent work directories.

visCreative does not bundle, depend on, download or install GSAP. GSAP is licensed separately by Webflow; authors must read and accept its license themselves before providing their own `gsap.js` in `render-libs`. Existing HTML that loads `/lib/gsap.js` fails with the localized `render.lib_missing` reason until that file is supplied. Agents may use an author library only after the author says it is available and must never install it or write into `render-libs`. Existing gateway permissions and command/file approvals still apply.

### Connect a real generation provider

1. Click the ⚙︎ in the top-right corner (or press <kbd>⌘</kbd> <kbd>,</kbd>).
2. Under **Generation services**, press **+ Add service** and choose a type: **Volcengine Ark**, **Kling**, **OpenAI Images**, **Alibaba Wan (DashScope)**, **MiniMax** or **Gemini** (all but Ark are marked not yet verified against the real API). Keep the preselected region, or choose **Custom URL** for your own gateway or dedicated endpoint (it must speak that service's API, and your key goes to that host). With a custom URL, set each operation's path under **API paths**; an empty path calls the base URL as is. Request and response formats stay those of the selected service. Then add models: known models are one click, or enter a custom model ID (for Ark, a model ID or inference endpoint ID from the Ark console). Default models and daily limits are under **Defaults and limits**.
3. Paste your API key and press **Save key**. It is written to the macOS Keychain or Windows Credential Manager (service/resource `vis-creative.provider`) and the input is cleared immediately.
4. Pick a default model, create an image node, write a prompt and hit generate. The model and its parameters can be changed per node from the prompt panel.

Audio uploads accept MP3, WAV, M4A, AAC, OGG and FLAC; audio-only MP4/WebM files are also detected as audio. Audio nodes show a waveform, playback controls and duration, with one node playing at a time. Settings includes an audio model list and default; without a configured default, audio generation uses **Mock music** (`mock-music-1`), with **Mock sound effects** (`mock-sfx-1`) also available. Video jobs can reference audio nodes; unsupported Ark audio references are rejected locally. Real Seed-Audio generation is deferred until official API documentation and invitation access are available; adding an audio model ID does not enable that adapter. TTS is outside this release.

**Editing** happens in timeline nodes (RFC 0024). Create one from selected shots or with Assemble timeline on a script node, then open it from its card (Open timeline or double-click).
- **Tracks:** one video track plus up to four audio tracks for music, sound effects and voice-over; up to 200 clips per track and 30 minutes in total.
- **Clips:** move, trim, ripple, split, duplicate and snap; set volume and fades.
- **Speed:** 0.25–4× with pitch preserved.
- **Transitions:** crossfade or dip to black at any cut; transitions overlap the clips and shorten the timeline.
- **Overlays:** up to two overlay tracks above the video and below text, for logos, stickers and picture-in-picture videos. Place each clip by centre, width and opacity in the inspector (six presets) or drag and resize it in the preview; fades fade the picture (and a video's sound). The preview plays one overlay video at a time and shows "Preview limited" beyond that; the export includes every overlay.
- **Text:** up to two text tracks with subtitle, variety, cinema and title presets. Use the four bundled fonts (Noto Sans SC, Smiley Sans, LXGW WenKai, ZCOOL KuaiLe) or upload your own TTF/OTF; you are responsible for an uploaded font's license. Caption linkage, on by default, moves and deletes captions with their video clip.
- **Preview:** the browser preview shows speed, transitions and text with the same fonts and timing as the export; small pixel differences are possible, and the export is authoritative.
- **Export:** ffmpeg renders a regular video or audio node; text-only timelines export on black.

Agents (Codex, DeepSeek, Claude Code) can build and edit the same timelines, including overlays, and export them.

Settings → Guardrails sets **Agent daily image/video/audio limits** (50/10/20 by default). Only paid jobs submitted by agents count against these limits, across all projects on the local date; `0` means unlimited. UI submissions neither consume nor face these limits. Maximum concurrency still applies to all paid jobs; mock and render remain unmetered. The top bar shows all paid submissions today, including failed and cancelled jobs; usage details separately list Agent used/limit.

<details>
<summary><b>Environment variables</b></summary>

| Variable | Purpose |
| --- | --- |
| `VIS_DATA_DIR` | Where spaces, blobs and `providers.json` live (dev default `~/.vis-dev`). |
| `VIS_WEB_PORT` | Fix the web host port (random by default). |
| `VIS_CODEX_PATH`, `VIS_CODEX_MODEL` | Override the Codex binary / model. |
| `VIS_DSH_PATH`, `VIS_DSH_MODEL` | Override the DeepSeek Harness binary / model. Resolution: explicit path → `PATH` → highest installed version in `~/.npm/_npx`. An invalid explicit path fails without switching versions. |
| `DEEPSEEK_API_KEY` | Optional dsh credential, passed through unchanged without logging or saving. Account login in `~/.dsh` is also supported. |

</details>

## Keyboard shortcuts

| Action | Shortcut |
| --- | --- |
| Pan and zoom | <kbd>Drag empty canvas / two-finger scroll; pinch / ⌘ wheel</kbd> |
| Select nodes with a box | <kbd>Shift drag</kbd> |
| Undo / redo canvas edits | <kbd>⌘ Z / ⌘ ⇧ Z / Ctrl Y</kbd> |
| Copy / paste / duplicate nodes | <kbd>⌘ C / ⌘ V / ⌘ D</kbd> |
| Delete selection | <kbd>Delete / Backspace</kbd> |
| Move focused nodes / move faster | <kbd>← ↑ → ↓ / Shift ← ↑ → ↓</kbd> |
| Move outside a frame | <kbd>⌘ drag</kbd> |
| Preview the selected image / video | <kbd>Space</kbd> |
| Step through versions / restore / leave version selection | <kbd>[ / ] / Enter / Esc</kbd> |
| Save text or prompt / cancel editing | <kbd>⌘ Enter / Esc</kbd> |
| Preview the previous / next node | <kbd>← / →</kbd> |
| Fit preview / original size / zoom in / zoom out | <kbd>0 / 1 / + / -</kbd> |
| Play / pause selected audio or preview video | <kbd>Space</kbd> |
| Seek preview video backward / forward 5 seconds | <kbd>J / L</kbd> |
| Step preview video backward / forward one frame | <kbd>, / .</kbd> |
| Mute / unmute preview video | <kbd>M</kbd> |
| Toggle the session panel | <kbd>⌘ \</kbd> |
| Send a message / insert a newline | <kbd>Enter / Shift Enter</kbd> |
| Switch between canvas and board | <kbd>⌘ ⇧ B</kbd> |
| Settings | <kbd>⌘ ,</kbd> |
| Open keyboard shortcuts | <kbd>?</kbd> |
| Close keyboard shortcuts or media preview | <kbd>Esc</kbd> |

Shortcuts are left to the browser while you are typing in a text field. On Windows/Linux use <kbd>Ctrl</kbd> instead of <kbd>⌘</kbd>.

## Repository layout

```
apps/
  web/                 Local web UI (React + React Flow) and its host process
  cli/                 `vis` — the thin client agents call; also serves MCP
  devcli/              Terminal client for development
  desktop/             Electron shell (planned)
services/
  studiod/             The daemon: gateway, wiring, provider and secret management,
                       work items, global execution slots and relationship permissions
packages/
  protocol/            RPC / event / error schemas — the single contract
  domain/              Core types, pure rules, cross-system ports
  storage/             SQLite schema (Drizzle), migrations, event log
  assets/              Import, versions, media probing, controlled reads
  generation/          Jobs, runner, delivery; providers: mock, render, Ark, Kling,
                       OpenAI, DashScope, MiniMax, Gemini
  canvas/core | ui     Canvas model and the canvas view
  workbench/core | ui  Spaces, sessions, agent runtimes; the session panel,
                       work tree, board, inbox and review drawer
  library/core | ui    Asset library: labels, organize runs, settings, series; the library panel
  previz/ui            Shot previz: full-screen panel editor
  writing/ui           Manuscript writing page
  timeline/ui          Full-screen timeline editor
  workbench/codex | deepseek | claude   Agent adapters
  ui-kit/              Shared theme and primitives
docs/rfc/              Design documents
```

**Dependency rules** (checked by `pnpm check`): `*-ui` packages depend only on `protocol` and `ui-kit`; `canvas-core` and `workbench-core` never depend on each other; `generation` delivers through a `domain` port instead of importing the canvas; `cli` depends only on `protocol`. New packages must be registered in `scripts/check-boundaries.mjs`.

## Development

Start with [CONTRIBUTING.md](CONTRIBUTING.md) for setup, validation and the RFC process, and [AGENTS.md](AGENTS.md) for repository rules. Integration guides cover [adding an Agent](docs/contributing/adding-an-agent.md) and [adding a generation provider](docs/contributing/adding-a-provider.md).

```sh
pnpm check                         # boundaries + typecheck + unit tests
pnpm build                         # CLI, daemon, dev client and web UI
pnpm --filter @vis/web test:e2e    # browser e2e (needs a build and Chrome)
pnpm --filter @vis/web perf        # timeline performance report under /tmp/vis-perf (needs a build and Chrome)
pnpm --filter @vis/web readme-shots  # README screenshots in English and Chinese (needs a build, Chrome, ffmpeg and a CJK font)
```

`readme-shots` starts an isolated daemon with the mock and local render providers and a scripted fake Codex, builds the sample production and writes `<tmpdir>/vis-readme-shots/{en,zh-CN}/*.png` (override with `VIS_SHOTS_OUT`). It never calls paid APIs or real agents. The README uses a subset of these images, converted to WebP under `docs/images/en` and `docs/images/zh-CN`; see `apps/web/readme-shots/CAPTURE.md`.

End-to-end tests run a real daemon and web host against a scripted fake agent and local fake provider servers. They never call paid APIs. The macOS sandbox regression creates a fake item in a test-only Keychain service and deletes it in finally; production keys are never queried.

[GitHub Actions CI](.github/workflows/ci.yml) checks and builds with Node 24 and runs one full browser e2e round on Linux for every pull request and push to `main`. Windows/macOS check and build run on pushes to `main` and manual dispatch only, to limit private-repository minutes. Manual runs also include Linux e2e. CI fetches caption fonts, provisions ffmpeg, reports any ASS-filter skips and uploads failure logs/screenshots; it needs no provider key or real Agent. Linux skips native approval cases through one shared helper because there is no isolation sandbox; registry and attachment coverage still runs. CI uses two browser workers with a 40-second default per-test budget and a temporary Fontconfig configuration for the fetched CJK fonts; local defaults remain 20 seconds and assertion waits are unchanged. Full Linux product support is not implied; platform coverage and expected skips are in [CONTRIBUTING.md](CONTRIBUTING.md).

## Security model

- The web host listens on `127.0.0.1` only and requires a per-launch token; it validates `Host` (against DNS rebinding) and `Origin` (against cross-site requests).
- Agents authenticate with a per-instance token and can only call methods whose `callers` include `agent`. Key management is UI-only.
- Ark submission records remain claimed while Windows retries a transient file replacement failure. Only the filesystem rename is retried; the paid HTTP submission is never repeated.
- Work-item permissions are enforced in the gateway by caller and workspace relationships: only root workspaces dispatch, agents manage only direct children, and only children report to a parent. Sessions without a work item cannot call work write methods. Shared canvas writes use revision checks; frames do not grant permissions.
- Provider API keys are stored only in the system credential store: macOS Keychain or Windows Credential Manager (`PasswordVault`, resource `vis-creative.provider`, userName = provider ID). Windows passes both the PowerShell script and key through stdin and discards the error stream. Keys never enter the database, config files, logs, events, error messages or agent tool responses, and never appear in a child process's argv.
- Windows agents run as the current user without an isolation sandbox and can technically read saved credentials, studiod tokens and databases. Use agents only in trusted projects. Gateway authorization, filtered environment variables and command/file approval rules still apply; `providers.list` reports `agentIsolation: 'none'` on Windows and Linux, and `'sandbox'` on macOS.
- On macOS, the entire Codex process tree runs inside Seatbelt: workspace writes, commands and networking are allowed; Keychain services and private studiod data are blocked, with an environment allowlist. All sessions auto-accept vis tool confirmations, including sessions without a work item. Other command/file approvals support one-time access, reuse of identical operations within a session, and denial; pending requests expire after ten minutes or on stop. Approval cannot bypass the outer write restrictions.
- CODEX_HOME is an explicit exception: the whole directory is readable and writable, including Codex credentials. Missing sandbox-exec or the public PEM CA file causes a read-only fallback with a notice. dsh stays read-only and its OS-level secret isolation remains unverified; see RFC 0005.
- Author protection is enforced in the gateway, not by prompts: Agents cannot overwrite or delete text you last edited, change panel pictures, save to your skill library, or delete work items. They can only request deletion, and a once-only approval card decides.
- Agent output is rendered as Markdown without raw HTML; nothing an agent writes is executed in the page.
- Windows agents run as the current user without an isolation sandbox or a read-only fallback. They could read locally stored API keys, application tokens and databases. Settings shows a persistent notice above the key input and under Safety & limits when the server reports `agentIsolation: 'none'`. Codex/dsh environments remain allowlisted; gateway permissions and tool approvals still apply. Auto approval resolves junctions before `..`, compares paths without case sensitivity, and asks for unresolved links.

## Design documents

| RFC | Topic |
| --- | --- |
| [0001](docs/rfc/0001-multi-agent-creative-space.md) | Multi-agent creative space — the overall design |
| [0002](docs/rfc/0002-sqlite-storage.md) | SQLite as the source of truth |
| [0003](docs/rfc/0003-core-contracts.md) | Core contracts: identity, revisions, generation inputs, undo, history |
| [0004](docs/rfc/0004-runtime-and-agent-entry.md) | Runtime and the agent entry point |
| [0005](docs/rfc/0005-agent-adapters-and-mcp.md) | Agent adapters and MCP |
| [0006](docs/rfc/0006-web-ui.md) | The web UI |
| [0007](docs/rfc/0007-generation-providers.md) | Generation providers, Ark, and key storage |
| [0008](docs/rfc/0008-projects-and-workspaces.md) | Projects, workspaces and project skills |
| [0009](docs/rfc/0009-work-items-and-board.md) | Work items, multi-agent dispatch and the board ([UI spec](docs/rfc/0009-ui-spec.md)) |
| [0010](docs/rfc/0010-workspaces-without-canvas-binding.md) | Shared project canvas, role-free sessions and a simpler session panel |
| [0011](docs/rfc/0011-project-delete.md) | Project deletion, Recently deleted, restore and permanent deletion |
| [0012](docs/rfc/0012-audio-assets-and-generation.md) | Audio assets and mock music/sound effects; Agent-only daily generation limits |
| [0013](docs/rfc/0013-agent-activity.md) | Agent activity in sessions: reasoning, status line, plans and friendly tool names |
| [0014](docs/rfc/0014-session-model-and-effort.md) | Per-session model, reasoning effort and speed (e.g. Codex Fast) |
| [0015](docs/rfc/0015-session-experience.md) | Session experience: attachments, auto-approval, separator layout, scroll-back history, drag to board, reparenting, queue resume |
| [0016](docs/rfc/0016-canvas-organization.md) | Canvas organization: categories, server placement, frames that contain nodes, tidy-up, code rendering, working docs, shortcuts |
| [0017](docs/rfc/0017-skill-import.md) | Importing and managing project skills: from a folder, a zip or another project, staged preview, replace and recoverable removal |
| [0018](docs/rfc/0018-i18n.md) | Chinese / English UI: follows the browser by default, switch in Settings, reason-based server errors and skill problems, a check against hard-coded copy |
| [0019](docs/rfc/0019-ui-polish-batch1.md) | UI polish, batch 1: an indigo accent, quieter header and canvas, Markdown in text nodes, a redesigned session composer |
| [0020](docs/rfc/0020-ui-polish-batch2.md) | UI polish, batch 2: one dialog and popover style, SVG icons, grouped settings, lighter cards, media nodes that follow the asset's aspect ratio |
| [0033](docs/rfc/0033-author-skill-library.md) | Author skill library: Agent drafts on request, author review/edit/save/discard in Settings, pinned project copies, update/publish/reset, new-project defaults, Markdown drafts and live session cards |
| [0034](docs/rfc/0034-agent-requested-work-cleanup.md) | Agent-requested child cleanup with once-only author approval, consequence binding and canvas preservation |
| [0035](docs/rfc/0035-silent-turn-watchdog.md) | Silent turns: warn and tell the parent without stopping anything, and make Stop finish against an unresponsive Agent |
| [0036](docs/rfc/0036-transparent-render.md) | Transparent local video: alpha WebM rendering, previews and timeline overlays, plus local ProRes 4444 MOV delivery |
| [0037](docs/rfc/0037-interactive-scene-nodes.md) | Interactive 3D scene nodes: a stage with named camera views, posable figures, props and imported `.glb` models, independent of previz and able to send views to images or panels |
| [0038](docs/rfc/0038-unreported-child-turns.md) | Unreported child turns: durable parent notices and board warnings, with at most two parent wakes until a report or author action |

RFC 0010 upgrades retain historical events and request records: older cursors resync from a current snapshot, and non-replayable old requests return `request_not_replayable` without re-execution. Workspace `lastChangeSeq` advances revisions even when the same node is edited again.

## Roadmap

- [x] RFC 0014 session model and reasoning effort selection, with next-turn application; Codex speed tiers such as Fast
- [x] RFC 0013 session activity UI: elapsed time, reasoning summaries, plan progress, and friendly tool names
- [x] Shared canvas with nodes, slots and revisions; provenance and reference edges; minimap
- [x] Codex and DeepSeek Harness sessions with streaming replies and node references
- [x] Manual image/video generation nodes with a floating prompt panel and quick-extend
- [x] Undo / redo, right-click menu, copy / paste / duplicate, download
- [x] Version history with peek, restore and save-as-node
- [x] Volcengine Ark provider with in-app configuration and Keychain-backed keys
- [x] MIT anime.js for deterministic local rendering, with optional author-managed `render-libs`, protected built-in names and localized missing-library errors; GSAP is separately licensed and is not shipped
- [x] Full-screen preview with zoom, a custom video player and in-preview version history
- [x] Storyboards: superseded by RFC 0023 script nodes (one node holds the whole shot table)
- [x] Cancel and regenerate for running jobs; cost guardrails
- [x] Per-node generation settings stored in the space
- [x] Work items and multi-agent collaboration: dispatch, board, inbox, review and user-only cascading deletion
- [x] RFC 0010: remove frame bindings and roles, use relationship permissions and event-based changes, simplify the session panel and board
- [x] RFC 0011: delete projects into Recently deleted, restore, and safely purge application data with optional project-directory deletion
- [x] RFC 0012 phase one: audio uploads and playback nodes, mock music/sound effects, audio reference inputs and Agent-only daily limits
- [ ] RFC 0012 phase two: Seed-Audio provider integration after official API documentation and invitation access
- [x] Experience polish, batch one: canvas wheel no longer fights nodes, related edges highlight on selection, consistent video node size, a slimmer new button, Agent icons, equal-height board columns with folded children
- [x] Experience polish, batch two: creating a project also creates its first workspace
- [x] RFC 0015 session experience: off-canvas files as attachments, auto-approval limited to in-directory commands and writes, separator layout, scroll-back history, drag to a board status, reparenting, resume or clear a paused queue
- [x] RFC 0016 canvas organization: categories and purpose, non-overlapping server placement, frames that contain and grow around nodes, tidy-up by category, manual code rendering, hidden working docs, empty-canvas shortcuts
- [x] RFC 0017 skill import: import project skills from a folder, a `.zip` / `.skill` archive or another project; staged preview with script warnings, opt-in replace, recoverable removal, unrecognized folders listed
- [x] RFC 0018 Chinese / English UI: follows the browser language by default, switch under Settings › General (persists across browsers), server errors and skill problems use localized reasons with English fallbacks, failure notices retain structured causes, legacy result diagnostics have explicit UI mappings, `pnpm check:i18n` rejects hard-coded Chinese UI copy
- [x] RFC 0019 UI polish, batch 1: one indigo accent for primary actions and selection, the project name shown once, debug details hidden, Markdown in canvas text nodes, a single composer card with a round send / stop button, Agent names on replies, an empty-session starter
- [x] RFC 0020 UI polish, batch 2: dialogs share one backdrop and close button while popovers (inbox, usage) never dim the page, text glyphs replaced by SVG icons, grouped settings navigation, single-layer session and board cards, and image / video nodes resized to the asset's aspect ratio by the backend when media is written
- [x] RFC 0022 Windows support: shared platform lockfile, portable build/test tooling, named pipes for studiod, Windows Credential Manager, shell-free Codex / dsh launch, junction-aware auto approval, folder picker and reveal, Chrome / Edge discovery, and an upfront notice that Agents run without an isolation sandbox Follow-up: shared skill ZIP limits, bounded atomic copy replacement, Claude/Codex exit ordering and a bounded manuscript outline have macOS regression coverage; Windows reruns remain open in [known issues](docs/known-issues.md).
- [x] RFC 0021 node components (phase 4a): a top toolbar on image / video / audio nodes driven by an operation catalog, provider-free ffmpeg edits as idempotent background tasks (crop, grid split, trim, frame grab, extract audio, custom and smart split, speed) with undo, generation operations shown only when a provider model declares them, editable node titles, one-row video controls and a seekable audio waveform, and an input panel with numbered references in prompts. Review fixes unify asset-only reference numbering, cancel media work on session stop or recall, guard writeback by its originating turn, stream transient progress, and handle oriented images and small duration differences
- [x] RFC 0023 script nodes, step 4b-1: a script node holding an editable storyboard table (row-level conflicts, undo, export), shared characters / scenes / props with reference images, an owning Agent session that breaks the script down and writes first-frame, end-frame and video prompts (stale / edited tracking), and single generation nodes created from a shot
- [x] RFC 0023 step 4b-2: first/last-frame continuity between shots (continuous shots reference the previous frame; optional strict mode extracts the previous video's last frame) and server-run batch frame and video generation that survives restarts, never submits twice, pauses on the daily limit, and runs only after the user confirms it or approves an Agent's request
- [x] RFC 0026 agent instructions: Codex and DeepSeek share one short English instruction text (346 words; Codex's always-loaded instructions are 66% smaller) that lets them use their own abilities and states the cost and concurrency rules with reasons; script, timeline, code-render, media, generation and canvas details moved into guides read on demand (`guide` tool, `vis guide [topic]`), and invalid script or timeline writes point to the right guide; agent-facing tool descriptions are in English; DeepSeek keeps subagents, workflows and background jobs inside the isolation; agents can no longer read Claude Code's credentials; an opt-in real-agent evaluation runner (`pnpm --filter @vis/web agent-eval`, Mock and render only) compares behaviour before and after
- [x] RFC 0025 performance pass 1: 1,000-node canvases open in under a second and pan at ~70 FPS (React Flow measurements kept, per-node selection, Markdown parsed once, plain text when zoomed out, per-slot history subscriptions); an idle studiod uses about 0.2 CPU s per minute instead of ~3 (cheap change check before each poll, contained flush errors with backoff, script batches polled only while pending approval or running; a batch paused by the daily limit wakes only on resume)
- [x] Polish (2026-11-05): cached ffmpeg 7+ export checks with localized version errors; canvas toolbars avoid fixed controls; clearer script cast/reference controls, one owner row, and readable library/service settings. RFC 0009 UI, 0015 and 0024 statuses now distinguish shipped work from remaining real-machine and real-Agent acceptance.
- [x] RFC 0024 timeline nodes, step a: a timeline node with one video track and up to four audio tracks, created empty or from selected shots in reading order; Agents build rough cuts (join shots, add and trim music, fades) through whole-document edits with server validation; export to a regular video / audio node through ffmpeg (stream copy when possible, hardware H.264 encoder detection) that pins the exported revision and links back with exportOf; the canvas card shows the latest export, a mini timeline and an out-of-date chip
- [x] RFC 0024 timeline nodes, step b: a full-screen editor opened from the timeline card (Open timeline or double-click) with a media bin, a preview player (two alternating video elements, Web Audio fades and track volumes on the AudioContext clock), an inspector and a timeline with move, trim, ripple, split, duplicate, snapping, zoom, multi-select and keyboard shortcuts; edits save in the background with revision checks, session undo, and a conflict banner when an Agent changes the document; server-side waveforms and filmstrips are cached per project and share the local media slots
- [x] RFC 0024 step c (part 1): Assemble timeline on script nodes (latest video per shot, else its first frame for its planned duration), canvas audio waveforms from cached server peaks instead of decoding in the browser, source frame rates recorded on video versions and used for timecodes and frame stepping, and the conflict banner naming the writing session
- [x] RFC 0024 step c (part 2): previews in their own one-slot queue so long exports no longer delay waveforms and filmstrips; a performance harness for the RFC §8 targets (`pnpm --filter @vis/web perf`, measured on macOS); no black frames at clip switches, no per-frame work while the editor is paused, and canvas edits to unrelated nodes no longer re-render the editor; exports checked with an LGPL ffmpeg build (VideoToolbox, libopenh264 fallback); browser e2e passes on macOS
- [x] Stability and memory: canvas video nodes show a cached poster frame (`media.preview` kind `poster`) and mount a player only while hovered, focused, selected or playing, so 30 idle video nodes add about 67 MB instead of about 430 MB to the page (`apps/web/perf/memory.perf.ts` measures it per stage with macOS `footprint`); flaky browser e2e cases now wait for the UI instead of reading it immediately
- [x] RFC 0024 Windows measurements and a real Codex trial: the §8 targets hold on the Windows reference machine except renderer memory after playback (about 490–540 MiB private, only partly released when the editor closes); a real Codex session built, edited and exported timelines in five scenarios without errors, and the Agent instructions now state plainly which effects timelines do not support yet
- [x] RFC 0024 step d: pitch-preserving clip speed (0.25–4×), crossfade and dip transitions with matching preview and export durations; up to two text tracks burned in through ASS with four presets, four bundled OFL fonts (`pnpm fonts:fetch`) or uploaded TTF/OTF fonts, text-only exports on black, and `font.list` for Agents; the editor adds speed presets, cut controls with overlap hatching, text lanes and a text inspector, and a caption-linkage toggle that moves and deletes captions with their video clip
- [x] RFC 0024 step e (part 1): image overlay tracks for logos and stickers — up to two overlay tracks drawn above the video and below text, each clip placed by centre, width and opacity with picture fades; added from the media bin, positioned in the inspector (six placement presets) or directly in the preview with snapping, and composited in export with alpha; a memory investigation found no per-cycle leak after playback (a native high-water baseline) and the canvas now releases title metadata probes (about 31 MiB with ten video nodes)
- [x] RFC 0024 step e (part 2): video picture-in-picture — overlay tracks also take videos, with trim, speed, volume, fades and track mute; the preview plays the topmost overlay video and freezes others with a "Preview limited" chip, while the export renders all of them with their sound
- [ ] RFC 0024 follow-ups: a real minimum-spec machine and the Windows LGPL ffmpeg build; Claude Code acceptance for steps d and e (Codex and DeepSeek passed both); single-clip audio operations (D3); raising the one-video preview limit after measuring a low-end machine
- [x] RFC 0027 asset library: a library panel where the project's library session names, categorizes and tags media on request (manual edits always win) and proposes merging media of the same subject into settings for the user to accept; project-level settings (characters, scenes, props and styles migrated out of script nodes, reference images pinned to asset versions; `generation.submit` accepts asset versions as inputs, and script generation adds the cast and style references itself); series: projects can be episodes of a series (grouped in the project switcher), whose shared settings live in their own series library; an episode links a copy pinned to a series version, shows when the series has a newer version or the copy was edited locally, and updates, publishes or resets only when the user asks; agents can list series settings and link one instead of recreating it, but never publish
- [ ] RFC 0028 Agent and provider registries (steps a–d done; real-API acceptance open): Agents are registered by descriptor (id, label, icon paths, install hint, extra environment names, credential paths the sandbox denies to every other Agent), so a new Agent is one adapter package plus one registration, with no protocol, storage or UI lists to edit; new workspaces can now pick Claude Code; sessions of a removed Agent stay readable but cannot run, and the board can still move their cards. Generation services are registered by type descriptor (regions, known models, help, settings fields, verified flag) and validated per type on save, load and job restore; the settings page is a generic Generation services page with a type chooser; every paid adapter runs one shared contract suite (no duplicate submits, lost responses end as unknown, cancel only when confirmed, bounded downloads, moderation reasons, no key in errors or logs), and synchronous APIs get a staging helper. Kling (video 3.0, 3.0 Omni and 4.0, image 3.0 Omni; a lost submit is recovered by its own task id) and OpenAI Images (GPT Image 2 and 2.5; synchronous, staged on disk) are in, along with Alibaba Wan through DashScope (Beijing and Singapore; US and EU need workspace hosts and are deferred), MiniMax (H3 video and `image-01`; no cancel, because the vendor's DELETE can destroy a finished task) and Gemini (Nano Banana images, Omni Flash video). All five stay marked not yet verified until real-API acceptance. Contributor guides cover [adding an Agent](docs/contributing/adding-an-agent.md) and [adding a service](docs/contributing/adding-a-provider.md). Next: real-API acceptance with the maintainer's keys
- [x] RFC 0029 shot previz, steps a and b: a canvas card and full-screen panel editor with pressure-sensitive pen, eraser, colour, size and session undo; notes, duration and aspect ratio; picker, drop, paste, sorted multi-file import and canvas image sources; content-hash upload retries and revision conflicts. The gateway protects existing panel pictures from Agent changes. Step b keeps the editor free and previz-only, with separate Previz setup and final Generation sections on the canvas (Paid is marked for key-requiring providers). It adds a horizontal panel strip, canvas panel actions, shot links and order-link previews, script-row thumbnails, Agent drafts, composition references with dropped-reference estimates, and idempotent reuse of finished panel frames in batches. The on-demand previz guide covers reading and asking rules. Step c adds Render previz drafts in the card and editor (save before closing), local three.js blockouts with poster-first review, frame extraction with one revision retry, distinct previz-only script outputs, and a short Agent guide. Fake Codex exercises the real local render and extraction; blockout frames feed mock batch composition while drawings remain visible. Blockouts have their own `previz` shot role and stay out of finished batch outputs and assembled timelines. Page splitting, 100-panel performance measurements, real-Agent/model acceptance and Windows WebGL measurements remain deferred; video references are on hold.
- [x] RFC 0032 [turn view, Send now and child working documents](docs/rfc/0032-turn-view-send-now-working-docs.md): consecutive activity folds into one expandable work block with visible result cards; Send now interrupts and prioritizes a queued message while preserving work-message order; child text defaults to working documents enforced by the gateway, with report links that open hidden documents. Standalone generation continues after interruption.
- [x] RFC 0031 [manuscript writing page](docs/rfc/0031-manuscript.md), step a: CodeMirror chapter outline and reading column, Han-aware word counts, revision-checked debounced autosave, conflict protection and history; preview TXT (UTF-8/GB18030), Markdown and DOCX imports before cursor insertion or canvas creation. Long-text and revision-growth measurements are recorded in the RFC; Step b adds selection actions sent to the open Agent, persistent anchored proposals with inline per-edit or batch review, atomic user acceptance, stale-edit protection, gateway enforcement for writer-owned text with revision-pinned user approval before Agent deletion, and read-only earlier-episode manuscripts in the same series. Step c adds selection/chapter breakdown into linked shots, source-passage navigation in both directions with grouped gutter markers, a compact selection toolbar with production actions under More, character/scene extraction that preserves existing settings, and resumable chapter-to-episode splitting through series project creation while retaining the original manuscript. Cursor-aware Markdown live preview hides syntax on inactive visible lines and reveals source for editing, selections, reviews and shot passages, preserving original text and bounded rendering.
- [x] RFC 0033 author skill library, step a: Agents draft only on request; edit, save or discard in Settings › My skills. Stable IDs and immutable content-hashed versions become explicit pinned copies under project `skills/` with origin metadata and no overwrite on name clashes. Agents cannot save to the library; fake Codex verifies cross-project use and turn delivery. Step b adds independent copy states, hash-guarded update/publish/reset with discard confirmations, optional new-project defaults, draft-only Markdown import, SKILL.md export, recoverable deletion, and live session draft cards with Review and Discard. Save as skill fills an editable composer request without sending.
- [x] RFC 0034 [Agent-requested child cleanup](docs/rfc/0034-agent-requested-work-cleanup.md): root Agents can request deletion of direct children; an explicit once-only author decision binds the shown consequences, expires after ten minutes or increased impact, and keeps canvas content. Approval never wakes the requesting Agent.
- [x] RFC 0035 [Silent turns and reliable Stop](docs/rfc/0035-silent-turn-watchdog.md): warn after ten quiet minutes (thirty with an open tool), clear on activity, and notify a child’s parent once without stopping it. Stop and Send now force an unresponsive turn to end after a bounded grace period, clean up approvals and queues, and terminate its process tree; recall and deletion use the same path.
- [x] RFC 0038 [Unreported child turns](docs/rfc/0038-unreported-child-turns.md): a completed child run without a report sends one durable notice per delivered batch, including unfinished generation counts and the final reply tail. Queued or active work delays the check; generation does not. Board warnings clear on the next child turn or report. Parent wakes are limited to two until a report or the author's own action resets the count; further notices stay in the author inbox.
- [x] RFC 0036 [Transparent local video](docs/rfc/0036-transparent-render.md), steps a and b: `render` accepts `transparent: true` for alpha WebM; probed alpha metadata drives checkerboards in canvas, results and previews, and timeline overlays preserve transparency. The video download menu exports ProRes 4444 MOV locally with a size estimate, cancellation and automatic temporary-file cleanup, without creating asset versions.
- [x] RFC 0030 [generation results in the session](docs/rfc/0030-session-results.md): one visible card per job at its last tool mention outside the work block, with image thumbnails, video posters, audio controls, localized failures, preview, locate and composer references; old sessions work without new storage, and Agent Markdown images become explicit links without automatic requests
- [x] Open-source readiness (RFC 0028 parallel track): GitHub Actions CI and [CONTRIBUTING.md](CONTRIBUTING.md) implemented; Linux check/build/e2e on PRs and main, Windows/macOS check/build on main and manual runs; hosted Linux check/build passed and the latest run passed 34 of 36 e2e files; remaining timing corrections await a rerun; remaining governance and license/history work open
- [x] README screenshots refreshed in English and Chinese from a reproducible capture harness (`pnpm --filter @vis/web readme-shots`: isolated daemon, local render and mock providers, fake Codex)
- [x] Real-use corrections: full chat messages, readable Markdown cards and viewport-styled writing with editable rendered tables, parent-visible child failures, explicit recovery or withdrawal of stranded messages, cross-project session jumps, and optional undoable removal of empty frames during tidy.
- [ ] RFC 0037 [Interactive 3D scene nodes](docs/rfc/0037-interactive-scene-nodes.md): step a is done, with a scene node and editor with figures, props, imported `.glb` models and camera views that save as images or go to previz panels. Step b is done too: select joints in the viewport or inspector, rotate within limits, apply standing, walking, sitting or pointing presets, and mirror a pose. Motion and Agent-written scenes come next
- [ ] Known issues: Windows test stability and small UI rough spots, listed in [docs/known-issues.md](docs/known-issues.md)
- [ ] Performance under load: unit and browser tests time out under machine load on Windows (page loads past 5 s, studiod and Chrome start-up per suite); browser e2e now runs four files at a time, which removed its setup timeouts at the same wall time; measure start-up, first page load and unit-test parallelism next, and check whether the app itself slows down
- [ ] Release: close idle projects (deferred from RFC 0011)
- [ ] Desktop app

## Acknowledgements

Much of visCreative was built with [Orca](https://github.com/stablyai/orca) ([onorca.dev](https://www.onorca.dev/)), an open-source environment for running a fleet of coding agents in parallel: one agent designing and reviewing while Codex workers implemented tasks in their own worktrees. Working that way every day shaped the work-items design here: a coordinator dispatching to workers, messages flowing back to an inbox, and a human reviewing before anything counts as done. Thank you to the Orca team.

The canvas is built on [React Flow](https://reactflow.dev) (MIT). We hide its attribution badge in the UI, so we credit it here.

## License

[MIT](LICENSE) © 2026 wengzq
