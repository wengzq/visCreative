# 0027 · Asset library: organized media, project-level settings, series

Status: Implemented (2026-11-03): steps a (media library), b (project settings) and c (series).

Date: 2026-11-02

Builds on [0016](0016-canvas-organization.md) (node categories), [0021](0021-node-components.md) (asset references in prompts) and [0023](0023-script-nodes.md) (script assets). 0023's out-of-scope list (不做) deferred a character library and cross-project reuse; this RFC picks them up.

Design reference outside the repo: `F:/workspace/设计参考图/资产库参考图/参考示例图1.png` (a "项目素材" panel: audio as a list, images and video as grids, category tabs per media kind). The maintainer's note on it: the layout is close, but most names are hashes and the same character is scattered over many files; **the Agent should tag assets and we merge them**, rather than users tagging by hand.

## Background

- **Two different things are both called "asset".** In storage and protocol, an asset is a media file with immutable versions (`assets`, `asset_versions`, `blobs`). In the script node (0023), an asset is a *setting*: a named character, scene or prop with a description and a reference image (`ScriptAsset`). Users mean both when they say 资产.
- **Media files cannot be organized.** An asset has only a `displayName`. Categories (0016) live on canvas nodes, not on assets, and there is no place that lists a project's media: you find a file by scrolling the canvas.
- **Settings are trapped in one script node.** A character defined in one script cannot be used by a second script in the same project, let alone the next episode. Its reference image is a canvas node id (`imageNodeId`), so deleting or moving that node breaks the setting.
- **Series are coming.** An episodic project reuses its protagonist, recurring scenes and props across episodes. The protagonist's design also evolves: a change made for episode 5 must not silently alter the finished shots of episode 1.

## Goals

1. One **library panel** per project with two tabs, **设定** (settings) and **素材** (media files), with categories, tags, search and "where is this used".
2. **The Agent organizes, the user decides.** On request, the project's library session names, categorizes and tags media; manual edits are corrections and are never overwritten. The Agent then proposes **merges**: groups of media that show the same character, scene or prop, or share one look (style), which the user accepts into one setting.
3. Settings become **project-level**: any script node, generation and Agent in the project can use them. Existing script assets migrate without breaking references.
4. A **series** groups projects (one project = one episode). Settings can be shared through a series library, with each project **pinned to a revision** and updating only when the user chooses.

## Out of scope

- Seasons or any level between series and project (maintainer, 2026-11-02).
- A global library shared across series (maintainer, 2026-11-02: not in the first version). The scope field below leaves room for it.
- Folder trees. Categories plus tags cover the same need without forcing an asset into one place.
- Organizing automatically in the background. Tagging costs Agent tokens (imported images must be looked at), so it runs only when the user asks (maintainer, 2026-11-02). Server-side heuristics without a model are also out: they would compete with the Agent's labels.
- Deduplicating near-identical copies and merging synonymous tags (maintainer, 2026-11-02: "归并" means grouping into a setting only). Identical bytes are already stored once by hash.
- Merging divergent edits of a shared setting. Conflicts are resolved by choosing a side (§3.4).
- Syncing libraries between machines.

## Decisions

### Terms

| UI (zh / en) | Code | Meaning |
|---|---|---|
| 资产库 / Library | library panel | the panel holding both tabs |
| 设定 / Settings | `entity` | named character, scene, prop or style: name, description, reference images, revision |
| 素材 / Media | `asset` (unchanged) | media file with immutable versions |
| 系列 / Series | `series` | ordered group of projects that share a settings library |

The script node UI renames its 资产 step to 设定 for consistency (copy-only change in `messages.ts`). Agent-facing text explains both words.

### 1. Media library (step a)

**Storage** (`space.db`, generated migration):

- `assets` gains `category text null` (free text, trimmed, ≤ 20 chars, same recommended values as 0016), `archived_at integer null`, `revision integer not null default 1`, and `labeled_by text null` (`'agent' | 'user'`; null = never labeled), plus `user_fields json` listing which of `displayName` / `category` / `tags` the user set by hand (§1.1).
- New table `asset_tags(asset_id, tag)`, primary key on both; tags are trimmed, ≤ 20 chars, ≤ 10 per asset, compared case-insensitively.
- Assets are never deleted by this RFC. **Archive** hides an asset from the library; canvas nodes that use it keep working.

**Effective category.** When `assets.category` is null, the library shows the category of the most recently created live node that has a category and whose current slot revision uses a version of the asset (0016's node category). Uncategorized nodes are skipped; if no categorized node uses the asset, timeline exports fall back to 成片, then other assets to null. Computed at read time, never written back, so moving a node to another category does not rewrite assets behind the user's back. An explicit asset category always wins.

**Protocol** (`packages/protocol/src/asset.ts`, registered for `ui` and `agent`):

```ts
asset.list: {
  params: {
    kind?: MediaKind
    category?: string | null        // null = uncategorized, by effective category
    tag?: string
    query?: string                  // trimmed; blank is absent; matches displayName, tags and titles of nodes that use it
    usage?: 'all' | 'used' | 'unused'   // default 'all'
    labeled?: boolean               // false = never labeled; omitted = both
    archived?: boolean              // default false
    cursor?: string; limit?: int ≤ 200  // default 100, newest first
  }
  result: {
    items: LibraryAsset[]
    nextCursor?: string
    facets?: { categories: { name: string | null, count: int }[], tags: { name: string, count: int }[] }  // first page only
  }
}
LibraryAsset = {
  assetId, kind, origin, displayName?, category: string | null, effectiveCategory: string | null,
  tags: string[], archived: boolean, revision, createdAt,
  labeledBy: 'agent' | 'user' | null, userFields: ('displayName' | 'category' | 'tags')[],
  latest: AssetVersionView, versionCount: int,
  usage: { count: int, nodeIds: Id[] },  // nodeIds capped at 20
  context?: { nodeTitles: string[], prompt?: string }  // only for agent callers: what the Agent needs to label without opening the canvas
}
asset.update: {
  params: { assetId, expectedRevision, displayName?: string | null, category?: string | null, tags?: string[], archived?: boolean }
  result: LibraryAsset
}
asset.label: {   // agent only: one transaction, idempotent by requestId
  params: { requestId, runId?: Id, items: { assetId, displayName?: string, category?: string, tags?: string[] }[] }  // ≤ 50 items
  result: { labeled: Id[], skippedFields: { assetId, fields: string[] }[] }
}
```

- `asset.update` bumps `revision` and emits `asset.updated { assetId, revision }`; a stale `expectedRevision` returns `revision_conflict` as elsewhere.
- Agent writes follow the canvas write rule: a linked, unarchived session. Metadata edits are cheap and reversible, so no approval.
- **Unused derived assets** (frame grabs, analysis frames from `asset.extractFrames`) are hidden unless `usage: 'unused'` or a nonblank trimmed `query` is given; otherwise every analysis would flood the library.

### 1.1 Agent organizing (step a)

Maintainer decisions (2026-11-02): runs only when the user asks; done by one session chosen per project.

- **Library session.** The project has one library session, like the owning session of a script node (0023 §4). The user picks it the first time they press **让 Agent 整理** (Organize with Agent); later presses send to it directly, and the panel header lets the user change it. The selected session must exist in this project, be unarchived and pass the same persistent Agent write eligibility checks used by `asset.label`, including its linked work item. `library.state` reports null if the stored selection later becomes unusable, and `library.runStart` rejects it with the same "choose a library session" error as an absent selection. A live turn is required when the Agent actually labels, not when selecting its session. Stored in `space.db` (`library_state.session_id`, a one-row table). Reasons are the same as 0023: one session remembers earlier naming decisions, so "二狗" stays "二狗".
- **What pressing it does.** The UI shows a confirmation with the number of unlabeled assets (images that need looking at are counted separately) and a note that this uses the session's model tokens; no generation provider is called. Then it sends the session an organize task (Agent-facing English, recommended categories in the user's language; the task points to the `library` guide) and the panel shows the session's working state.
- **What the Agent does.** Read `asset.list { labeled: false }` page by page, use `context` (node titles, generation prompt) where it is enough, and look at the file through `asset.get`'s `path` only when it is not; then write `asset.label` in batches of ≤ 50. Names are short and human (`二狗·正面`, not `3a3f58…`). Categories use the recommended values; images: 角色 / 场景 / 物品 / 风格 / 其他; video: 视频片段 / 成片.
- **User edits win.** `asset.update` from the UI records the edited fields in `user_fields` and sets `labeled_by: 'user'`. `asset.label` never overwrites a user field and reports it in `skippedFields`; whenever it changes writable fields, it sets `labeled_by: 'agent'`, even when other fields remain protected by `user_fields`. `confirm: true` applies any fields sent in the same call first, then sets `labeled_by: 'user'` and protects all three fields, with one revision bump. Running Organize again only labels assets that were never labeled, unless the user chooses "relabel everything except my edits".
- `asset.label` writes are metadata only, so they apply directly, without approval.
- **Undoing a bad run.** Each organize task gets a run id (`library_runs(id, session_id, kind 'label' | 'merge', started_at, reverted_at)`); `asset.label` takes it as `runId`, and the server stores each asset's previous label fields in `library_run_changes(run_id, asset_id, before json)`. The panel offers **撤销这轮整理** (Undo this run) on the latest runs: `library.run.revert { runId }` (`ui`-only) restores `before` for every asset whose label fields still hold what the run wrote, and reports the rest as skipped. This is deliberately **not** the canvas undo stack: canvas undo steps are keyed by node (`canvas/core/src/undo.ts`), and Ctrl+Z on the canvas silently reverting a labeling run in a closed panel would surprise users.
- **成片 without the Agent.** Video assets produced by `timeline.export` (0024, `exportOf`) get the effective category 成片 automatically; everything else comes from the Agent or the user.

**UI** (`packages/library/ui` panel, mounted by `apps/web`), following the reference image:

- A **资产库** button in the canvas top bar toggles a right-hand panel; the open state persists per project in local storage. Header: search, import, **让 Agent 整理**, and the library session.
- **素材** tab: one section per media kind, each collapsible with a count. Audio is a list (name, duration, play on click); images and video are thumbnail grids (video shows its duration). Each section has category tabs: 全部 plus the effective categories present in that kind, uncategorized last. Tag chips and "unused", "unlabeled" and archived toggles filter all sections. Thumbnails reuse the existing previews and video posters.
- Assets labeled by the Agent and not yet reviewed show a small marker. Editing sets `labeled_by: 'user'` and protects the edited fields; a later Agent change to another field restores the review marker. Pressing "looks right" confirms all three fields (`confirm: true`), preserving existing values for omitted fields and applying any supplied values before confirmation, so a later relabel leaves them alone.
- Click opens a detail drawer: versions, usage list (click focuses and selects the node on the canvas), name, category, tags, archive. Multi-select applies category or tags to several assets (the UI issues one `asset.update` per asset, capped at 50).
- Drag from the panel to the canvas creates a media node at the drop point with `content: { assetVersionId }` of the latest version. Dropping files on the panel imports them through the existing upload path without creating nodes.
- Copy goes into `messages.ts` in both languages; selectors in e2e use aria labels.

### 2. Project-level settings (step b)

**Storage** (`space.db`):

```text
entities(
  id, kind ('character' | 'scene' | 'prop' | 'style'), name, description,
  refs json,            // [{ assetVersionId, label? }], ≤ 4, first is the cover
  revision, created_at, updated_at, deleted_at,
  series_entity_id null, series_revision null   // reserved for step c, always null in step b
)
unique (kind, lower(trim(name))) where deleted_at is null
```

- **Reference images point to asset versions, not canvas nodes.** A setting stays valid when its canvas node is deleted, and it can travel to another project (§3). The UI still lets users pick a canvas image node; the server stores that node's current asset version and remembers `sourceNodeId` only for a "show on canvas" link.
- Names are unique per kind within the project so Agents and users can refer to "林夏" unambiguously.
- **Members.** `entity_assets(entity_id, asset_id, role)` with role `'image' | 'video' | 'voice' | 'other'` links every media file that shows or belongs to the setting: the "二狗" card holds its five images, its voice line and the two clips it appears in. Membership is many-to-many, including within one kind: a group image or clip can show several characters. References do not create members; membership changes only through `entity.create`, UI `entity.update`, accepted proposals, or unmerge (plus the one-time legacy migration). A ref can point to any usable project image version; the media library shows a setting chip for both its members and ref assets. The voice member is kept for future audio generation and shown on the card.

### 2.1 Merging into settings (step b)

Maintainer decision (2026-11-02): "归并" means grouping media that show the same subject into one setting. It runs after labeling, in the same organize task or on its own button **整理成设定** (Group into settings).

- **The Agent proposes, the user accepts.** Creating or changing settings affects scripts and future generation, so the Agent never writes `entity_assets` directly. It calls `entity.propose`:

```ts
entity.propose: {   // agent only, idempotent by requestId
  params: { requestId, proposals: {
    entityId?: Id                  // add to an existing setting; omitted = new setting
    kind, name, description?
    members: { assetId, role }[]   // ≥ 1
    refs?: Id[]                    // assetVersionIds among the members, ≤ 4, first is the cover
    reason: string                 // one line shown to the user: "same husky, same collar and voice name"
  }[] }                            // ≤ 20 per call
  result: { proposalIds: Id[] }
}
```

- Stored in `entity_proposals(id, request_id, session_id, payload json, status 'pending' | 'accepted' | 'rejected' | 'superseded', created_at, resolved_at)`. A new proposal touching the same assets supersedes older pending ones; a proposal whose assets were archived, or whose target setting changed revision since it was made, is shown as needing a re-check.
- **Review UI.** The 设定 tab shows a **待确认归并** (Pending merges) strip above the cards. Each proposal shows the name, kind, reason and member thumbnails; the user can rename, untick members, change the cover, then **Accept** or **Reject**, or accept all. `entity.proposal.resolve { proposalId, accept: boolean, edits? }` is `ui`-only and applies in one transaction: create or update the entity, link members, set refs, emit `entity.created` / `entity.updated`. Reversal is explicit, as for labels: a setting card offers **取消归并** (Unmerge) for the members added by its latest accepted proposal, and deleting a setting unlinks all its members (assets themselves are never deleted).
- After acceptance the members show the setting's name as a chip in the 素材 tab, and filtering by a setting is a filter like any tag.
- Users can also merge by hand: multi-select media → **归为设定…** (new or existing), which goes through the same transaction without a proposal.

**Migration of 0023 script assets** (a contract migration recorded in `contract_migrations`, run once per project on open):

- Each `ScriptAsset` becomes an entity **with the same id**, so `characterIds`, `sceneId`, `propIds` and `{{asset:<id>}}` tokens in cells keep working unchanged.
- `imageNodeId` becomes one ref and one `image` member: that node's current image version and its asset. A missing node or empty slot gives neither.
- If two scripts in a project define the same kind and name, the later one (by script node `createdAt`) is renamed `<name> · <script title or 脚本 N>`; nothing is merged automatically.

**Style (maintainer, 2026-11-02).** A style setting is the look of the work: art style, palette, lighting, lens and grain (`电影级写实，冷暖对比，35mm 胶片颗粒`). Its description is the prompt text, its refs are 1–4 sample images passed as style references. A project can have several (main look, flashback, dream).

- Script nodes pick one style: `ScriptDoc.style` (free text, 0023) is replaced by `styleId: Id | null`. `doc.set` and `script.replace` accept `styleId`; a `style` string is still accepted as an alias that finds or creates a style setting with exactly that description, so 0023 Agent prompts keep working.
- Migration: each script with a non-empty `style` gets a style setting whose description is that text, named `<script title or 脚本 N> 风格`. Scripts with identical text share one setting.
- Generation from a script (single shot and batches) appends the style description to frame and video prompts the way 0023 used `style`, and adds its refs after the shot's character, scene and prop refs. When the model's reference limit is reached, style refs are dropped first and the confirmation dialog says so.
- Changing a style marks stale every shot of every script that uses it.
- A shot does not override the script's style in this RFC; a flashback uses its own script node or a style named in its prompt.

**Script documents.** `ScriptDoc.assets` is replaced by `castIds: Id[]`, the settings this script uses, in display order. The asset parts of `script.patch` and `script.replace` stay valid as aliases: add creates a project entity and appends it to the cast, update edits the entity, delete removes it from this script's cast and clears this script's shot references, without deleting the shared setting even after its last script use. Deleting the shared setting remains UI-only `entity.delete`. In `script.replace`, an asset whose kind and name match an existing project setting is cast instead of duplicated, so an Agent rewriting a script does not fork "林夏". Name reuse applies any provided description and `imageNodeId` to the shared setting, bumps its revision and marks referencing prompts stale; omitted fields stay unchanged. `imageNodeId` replaces only the cover (the first ref), while null removes only that cover; other refs survive, including when the source is initially an empty image node. Explicit `castIds` and inserted alias rows are combined in stable order, explicit IDs first. This keeps Agent prompts and batches from 0023 working. Prompt staleness (0023 §107) now fires across every script whose shots reference a changed entity.

**Protocol** (`packages/protocol/src/entity.ts`, `ui` and `agent`):

- `entity.list { kind?, query?, includeDeleted? }`, `entity.get { entityId }`.
- `entity.create { requestId, kind, name, description?, refs? }`, `entity.update { entityId, expectedRevision, name?, description?, refs? }`, `entity.delete { entityId, expectedRevision }`.
- Events `entity.created / updated / deleted`. Same write rule as canvas for Agents.
- **Generation inputs accept asset versions**: `generation.submit.inputs` items become `{ slotId, revision? } | { assetVersionId }`. Script batches and Agents pass a setting's refs directly instead of looking up an image node. Contract tests cover both shapes; the 0021 numbering of references ("图片 N") counts both kinds in order.

**UI:** the **设定** tab shows cards grouped by kind (cover, name, description excerpt, number of shots using it, missing-reference warning). The card editor is the one from 0023 §7 step 2, moved into a shared component; the script node's 设定 step shows the cast and an "add from library" picker.

### 3. Series (step c)

Revised 2026-11-03 before work starts, with the maintainer's approval of the UI below. Mockups live in the conversation record; this section is the contract.

**3.1 Model.** `app.db` gains `series(id, name, created_at, deleted_at)` and `spaces.series_id null` plus `spaces.episode integer null` for ordering. A project belongs to at most one series. Episode numbers are unique among a series' live projects and default to the next number.

- **New episode.** The new-project dialog offers 独立项目 or 作为系列的新一集 (series picker, or a new series by name, plus the episode number). `space.create` gains optional `series: { seriesId } | { name }` and `episode`.
- **Join a series.** An existing standalone project can join a series from its project menu. The join dialog lists the project's settings with a checkbox each, to publish them as series settings in the same step: all ticked when the series has no settings yet (typically turning episode 1 into a series), none ticked otherwise. Leaving a series keeps every setting as an episode-only setting.
- **Project list.** Projects of one series are grouped under the series name, ordered by episode, with the episode count; standalone projects follow.
- **Deleting a series** (UI-only, confirmation) detaches its episodes: their linked settings become episode-only settings with the same content. Deleting or purging an episode never touches the series library.

**3.2 Series library storage.** Each series has its own directory under the data dir: `series/<id>/library.db` (entities with revision history: `series_entities`, `series_entity_revisions`) and `series/<id>/blobs/` (same content-addressed layout as projects). Not in `app.db`, because media blobs and revision history would bloat it and the global write lock is shared with execution slots.

**3.3 Linking copies, not live references.** A project uses a series setting by **linking** it: the server copies that revision's name, description and refs into the project's `entities` row with `series_entity_id` and `series_revision` set, and copies the needed blobs into the project's blob store (hard link when on the same volume, else copy). The copied refs become the setting's `image` members in the project; a series revision also carries its voice member, if any. Other members (clips, extra shots) stay in the episode that made them. Reasons:

- Every project stays self-contained. `space.db` remains the source of truth, deleting or moving a series cannot break an episode, and there are no cross-database transactions.
- The pin is the copy itself: episode 1 keeps the protagonist exactly as it was when its shots were made.

Linking when the episode already has a live setting of the same kind and name asks the user to either **use the series version** (the local setting becomes the linked copy, keeping its id so scripts keep their cast; its revision bumps and prompts go stale) or cancel. Agents get `invalid_params` (`entity.name_taken`) with both ids and leave the choice to the user.

**3.4 Updating in both directions.** All explicit, never automatic, one setting at a time:

- **Update from series.** When the series has a newer revision, the card shows **⬆ 系列有新版本** and the 设定 tab label carries the count (设定 · 3 个有新版本); there is no project-wide indicator beyond that. The update dialog shows the pinned and the new revision side by side (cover, name, description), the number of shots in this episode casting it, and states that other episodes stay on their own revisions. Updating replaces the local copy, bumps the entity revision and therefore marks affected prompts stale (0023 rules), so the user sees which shots may need regenerating. 暂不更新 keeps the badge.
- **Publish to series.** Only in the setting editor (not on the card, to avoid accidental publishing): it turns a project setting into a new series revision, or a new series setting when it is not linked yet. Without a conflict it is one confirmation ("publish as v6; other episodes will see a newer version"). If the series moved on since the local pin, the user chooses: overwrite the series with this version (it becomes the next revision), or take the series version and discard local edits. No merging.
- A linked setting edited locally is marked **✎ 本地已修改** until it is published or reset. **还原为系列版本** in the editor replaces the local copy with the pinned revision (no newer revision is pulled in implicitly).

**3.5 Presentation in the library panel.**

- The 设定 tab keeps one list. **本集设定** comes first, grouped by kind as today; each card carries **系列 v3** when linked, plus the badges above. Episode-only settings carry no series badge.
- Below it, a collapsed section **系列「<name>」里本集还没用的设定 (n)** lists series settings not linked into this episode, with **用到本集** on each card. Search covers both sections. Projects outside a series do not show the section.
- The script node's **从资产库添加** picker lists series settings after the episode's own; picking one links it, then casts it.
- Media members are never shared: the 素材 tab shows only this episode's media, including blobs copied in by linking.

**3.6 Permissions.** Agents can list series settings and link them into their project (a project write, same rule as `entity.create`). Publishing to a series affects every episode, so in step c it is **UI-only**, as are update from series, reset, joining, leaving and deleting a series; a later RFC can add an approval-gated Agent path. Enforced in the gateway by caller.

**3.7 Contract sketch** (`packages/protocol/src/series.ts`; exact shapes are written before dispatch):

| Method | Callers | Purpose |
|---|---|---|
| `series.list` / `series.create` / `series.rename` / `series.delete` | ui | manage series |
| `space.setSeries` | ui | join or leave a series, set the episode, optional settings to publish |
| `series.entityList` | ui, agent | series settings with their latest revision and whether this project links them |
| `entity.link` | ui, agent | link a series setting into this project (requestId; name collisions as in §3.3) |
| `entity.seriesDiff` | ui | pinned vs latest revision for the update dialog |
| `entity.updateFromSeries` / `entity.publish` / `entity.resetToSeries` | ui | §3.4, each with `expectedRevision`; publish carries the series revision it expects and returns `revision_conflict` when the series moved on |

`EntityView.series` (already reserved) carries `seriesEntityId`, `revision`, `modifiedLocally` and gains `latestRevision`. Events: `series.changed` on the app connection; a project emits `entity.updated` for its own rows only, and each open project rechecks `latestRevision` when `series.changed` arrives.

**3.8 Room for a global library.** Series storage is addressed by a scope id, so a later global library can be one more library directory with the same tables and the same link/publish rules, without migrating projects.

**3.9 Acceptance (c).** e2e (fake Codex): create series 山海少年 from a project with two settings through the join dialog (both ticked); create episode 2 as a new episode; link 二狗 from the collapsed section and cast it through the script picker; edit and publish 二狗 from episode 2; episode 1 shows the newer-version badge and the tab count, still renders its pinned cover, and updating marks its shots stale; a concurrent publish from episode 1 offers the two choices; deleting episode 2 leaves the series and episode 1 intact; the fake Agent lists and links a series setting but `entity.publish` is refused for agent callers. Unit: blob copy on link, name-collision paths, modified-locally tracking, reset, detach on series delete.

## Code layout

Following the 0024 timeline editor, the library gets its own pair of packages (maintainer, 2026-11-02):

| Path | Package | Contents |
|---|---|---|
| `packages/library/core` | `@vis/library-core` | library listing and labeling, runs and revert, settings, members, merge proposals; later the series library |
| `packages/library/ui` | `@vis/library-ui` | library panel: 素材 and 设定 tabs, pending merges, setting card editor (moved here from the script node) |
| `packages/protocol/src` | — | `asset.ts` extended, new `entity.ts` and `library.ts`; `series.ts` in step c |
| `packages/storage/src/schema` | — | new tables in `space.ts`; step c adds a schema for `library.db` |
| `services/studiod` | — | wiring, gateway caller rules, series directories in step c |
| `packages/workbench/core/src/instructions/guides/library.ts` | — | the `library` guide (Codex, DeepSeek); Claude keeps the same rules inline in its `prompt.ts`. The organize and merge task messages are built in `apps/web/src/client/library-prompt.ts` |
| `apps/web` | — | mounts the panel, drag to canvas, injects the library picker into the script node |

Layering (`scripts/check-boundaries.mjs`):

- `library-core` may depend on protocol, domain, storage and assets. `assets` stays the blob and version layer only.
- `canvas-core` may depend on `library-core`: scripts cast settings, and the 0023 migration and script op aliases call the settings service.
- The other direction goes through a port: when a setting changes, `library-core` calls an `onEntitiesChanged(tx, entityIds)` hook that studiod wires to canvas-core to mark prompts stale, the same pattern generation uses to deliver to the canvas. No cycle.
- The rules above are registered and `packages/library/core` exists as an empty package; the worker that creates `packages/library/ui` only adds its package.
- `library-ui` depends only on protocol and ui-kit and is mounted by `apps/web` (and `desktop`). `canvas-ui` does not depend on it; the script node's "add from library" picker and setting editor are injected by the host, as the timeline editor is.

## Implementation split

Contract first: I write the protocol changes for each step before dispatching workers.

| Step | Scope | Can run in parallel with |
|---|---|---|
| a1 · media library backend | storage migration, `asset.list` / `asset.update` / `asset.label`, user-field protection, effective category, `library_state`, events, gateway rules, organize task text in Agent prompts | b1 |
| a2 · media library UI | panel per the reference image, 素材 tab, detail drawer, Organize with Agent (session pick, confirmation, working state), review marker, drag to canvas, e2e | b1 (after a1 contract lands) |
| b1 · settings backend | `entities`, `entity_assets`, `entity_proposals`, contract migration from script assets, script op aliases, `entity.*` / `entity.propose` / `entity.proposal.resolve`, generation inputs by asset version, cross-script staleness, merge task text in Agent prompts | a1, a2 |
| b2 · settings UI | 设定 tab, pending merges review, manual "group into setting", shared card editor, script cast picker, e2e | after b1 |
| c · series | revised §3 (2026-11-03); split into backend (app.db, series library, link/publish, gateway) and UI (project dialogs, 设定 sections, update/publish dialogs, picker) | backend first, UI after its contract lands |

Directories: a1 and b1 both touch `packages/storage` migrations, so b1 generates its migration after a1's is merged to avoid two migrations with the same number.

## Acceptance

- `pnpm check`, `pnpm build` and two full e2e rounds pass.
- e2e (a, fake Codex): import three files; Organize with Agent asks for the session once and shows the count; the fake Agent labels them through `asset.label`; the user renames one, runs Organize with "relabel" and the rename survives; filter by tag, archive one, drag another to the canvas, open its usage and jump to the node.
- e2e (b, fake Codex): the fake Agent proposes one merge (three images + one audio); the user unticks one image and accepts; the setting card shows the cover and voice, the three remaining members show its chip. A project with a 0023 script opens after migration with all shot references intact; a character created in script 1 is cast in script 2; editing its description marks prompts in both scripts stale; deleting the canvas image node that was its reference leaves the setting's image intact.
- Unit: effective category picks the latest live node; tag limits and case-insensitive matching; `asset.label` skips user fields and is idempotent; a newer proposal supersedes an older one on the same assets; accepting a proposal for a setting whose revision moved is refused until re-checked; migration renames duplicate names and preserves ids; scripts with identical `style` text migrate to one style setting, and a `style` string in `script.replace` finds that setting instead of creating another; `generation.submit` accepts both input shapes.
- No test calls a real Agent or model; organizing in development uses the fake Codex.
- Library panel with 1,000 assets opens in under 1 s and scrolls without long tasks over 50 ms (the grid is virtualized).

## Settled questions

- Text nodes (scripts, copy) are **not** in the library (maintainer, 2026-11-02). The library is for reusable media and settings; text is found on the canvas.

## Implementation notes (A1)

- Media library tags retain their trimmed spelling and use a separate lowercase column for indexed, case-insensitive uniqueness and filtering.
- Reverting a label run compares the complete label snapshot, including user confirmation metadata, so confirming unchanged text protects it from a later revert. User edits made between batches of the same run also prevent revert, even when the later batch recorded them in its output snapshot. Archive-only edits preserve label status and do not prevent reverting labels.
- Export provenance is read from the exported node's first immutable slot revision, including deleted nodes, so an exported cut keeps its fallback category after its node is deleted or its slot is replaced.
- The backend listing performance test prints elapsed time for 1,000 assets and 2,000 live nodes without a wall-time assertion.
- Follow-up review shares persistent session eligibility between gateway Agent writes and library selection, state and run creation. Missing, archived, unlinked, stopped-work and deleting-work selections are unusable; turn/token checks remain in the gateway.
- Queries are trimmed, blank queries retain normal derived-asset hiding, and effective category skips uncategorized live nodes. Search preserves JavaScript Unicode case folding over lightweight text candidates before SQL usage/category aggregation.
- Agent edits restore the review marker even after partial user edits, while protected fields remain skipped. Confirmation applies supplied values first and confirms all fields in one revision.
- Lists filter candidate assets in SQL before usage/category work, aggregate first-page facets in SQL, and build full media views only for the returned page. State counts use SQL, and update responses restrict view reads to one asset.
- Asset version views share the mapping exported by `@vis/assets`; label run snapshots reuse the asset row already read for that batch item.

## Implementation notes (B1)

- Current script revisions store `castIds` and `styleId` alongside embedded `assets` / `style` compatibility snapshots. Current canvas reads project those aliases from live settings; history and turn snapshots retain the embedded data of their original revision. The two new fields remain optional in the schema solely to read immutable pre-0027 history.
- Restoring script rows or casting historical asset aliases uses the latest shared settings, and never rolls back another script's setting edits. Historical aliases match live settings by kind and name; deleted selections are omitted when undo restores a document. Existing slot revision conditions still guard undo against intervening writes.
- An internal `entities.pending_source_node_id` preserves 0023's empty image-node preparation workflow. The script projection shows that live pending node until its first image arrives. Canvas image writes, including generation delivery, replace the cover with the version without adding a member, retain other refs, clear the pending pointer, publish `entity.updated`, and invalidate referencing scripts in the same transaction.
- Membership is many-to-many, including within one kind: a group image or clip can depict several characters. Both migrated settings keep their references and members. Pending proposals sharing a media asset still supersede each other, independently of accepted membership (coordinator decision, 2026-11-02).
- Duplicate setting names use `invalid_params` with reason `entity.name_taken` and `params.entityId`, `kind`, and `name`, preserving the existing error-code enum (coordinator decision, 2026-11-02).
- `job_inputs` stores exactly one source: a pinned slot revision or a project asset version. Drizzle generation requires adding the version column before rebuilding the table to make slot columns nullable; migrations are generated in separate stages to preserve existing jobs. Regeneration reuses the original resolved prompt and pinned inputs.
- Script generation orders character, scene, and prop image versions before style samples. Continuity inputs are retained; style samples are omitted first at the provider reference limit, followed by excess cast samples in display order. `script.batch.plan.estimate.styleRefsDropped` and `castRefsDropped` expose the omitted sample counts. Frame-based videos continue to submit frames alone; settings are already incorporated in those frames.

- Follow-up review decisions (2026-11-03): script `asset.delete` never deletes a shared setting; refs never implicitly add members. The library's belongs-to lookup includes both membership and ref assets. Legacy migration alone explicitly preserves the former image membership.
- Insert/replace name reuse applies provided description/image fields with normal revision and staleness semantics, preserving omitted fields. `imageNodeId` changes only the cover; pending cover assignment retains the other samples. Replacement combines explicit cast IDs with inserted rows in stable order.
- Pending adoption validates only the incoming image and skips/logs unusable versions without blocking slot writes or paid delivery. Contract migration skips unavailable image refs/members and returns `migrated` / `skippedRefs`; it includes deleted script heads and preserves presence-undo guards so a restored script stays editable.
- Coordinator clarification superseding follow-up item 6: shot-linked `generation.submit` remains the server-only create-from-shot boundary, with no host UI or contract change. Caller inputs stay first and keep their numbering; missing cast refs are appended, followed by style refs, regardless of caller input shape. Duplicate pinned versions are skipped, including slot inputs; only images consume reference capacity. Explicit inputs are never dropped, style samples drop before cast samples, and frame-based videos retain frames alone. Batches use their already planned inputs without a second injection. Agent prompts explain automatic shot-target refs and manual refs/style for other targets.
- Current canvas reads project every script's cast and style with one batched settings/source-node query; direct generation versions and source aliases resolve in batches. Normalized name lookups use the live `lower(trim(name))` unique index. Submission and batch catalogs share `referenceImageLimit`, using the adapter capability or Infinity, without duplicated provider constants.

## Implementation notes (integration)

- The media library chip and the `entityId` filter use the same relation: live settings whose members or refs include the asset. `library.state.pendingProposals` counts pending proposals.
- `entity.propose` with a `runId` requires the caller's own active `merge` run, as `asset.label` requires an active `label` run. A merge run's `changeCount` is the number of proposals it made. Reverting it withdraws (rejects) its pending proposals and reports accepted ones as skipped; accepted merges are the user's decision and are undone per setting with **取消归并** (`entity.unmerge`).
- The web host composes one panel host from the media and settings adapters. The panel header shows **让 Agent 整理** (label runs) on the 素材 tab and **新建设定** plus **整理成设定** (merge runs) on the 设定 tab; both share the session pick. One search box serves the selected tab. **在素材中显示成员** in the setting editor opens 素材 filtered to that setting.
- This RFC was drafted as 0026 and renumbered to 0027 when [0026](0026-agent-instructions.md) (agent instructions) landed first. The contract migration id `0026-entities` keeps its original name so databases that already ran it do not run it again.
- Following 0026, the Agent guidance for this RFC lives in the on-demand `library` guide (`vis guide library`) instead of each adapter's prompt; the script and generation guides point to it. Agent-facing method text for `asset.list`, `asset.label`, `library.state` and the `entity.*` methods is English; recommended category names stay in the user's language in the organize task message.
- Fonts (RFC 0024 step d) are assets of kind `font`; they belong to timelines and never appear in the media library, its counts, labeling or setting members.
- Series (step c, after review): an Agent `entity.link` needs an active turn but no work item, the same rule as `entity.create`, so the library session can link series settings. `entity.list` takes an optional `spaceId` so the join-series checklist reads another project's settings without switching to it; agents passing `spaceId` to `entity.*` are refused. Publishing records the published ref and voice members as series copies, so a later update or reset in the publishing episode replaces them instead of duplicating them. The publish, update and reset dialogs reuse one `requestId` per choice while open, and `space.setSeries` pins each checklist setting's expected revision in its plan, so retries after a half-finished write complete instead of conflicting. `events.seriesChanged` always names the series (old and new on a membership change).

## Implementation notes (A2)

- The web host persists panel visibility and selected tab per project. The panel sits between the working canvas and session panel; below 1,000 CSS pixels it becomes an overlay. The timeline editor retains its existing overlay.
- The UI-only `asset.versions { assetId }` read returns all immutable versions newest first, including versions with no live canvas references. This additive contract fills the detail drawer's history requirement without inferring version IDs.
- Each media kind uses cursor pages and a bounded virtual viewport. Metadata, usage and setting events trigger debounced refreshes; transcript changes do not reload media. Setting names are resolved once on mount and after setting events.
- `LibraryRunControls` supports both label and merge runs. The host sends explicit run IDs with Agent tasks, preserves manual edits during relabel, and exposes undo results with reverted and skipped counts. The shell provides `settingsHeader` and `renderGroupIntoSetting` slots for the settings worker.
- Browser tests use local PNG, WAV and MP4 files and the fake Codex. A separate production React probe measures opening and scrolling 1,000 assets while checking that only a bounded number of cards mount.
- The generic canvas drop adapter respects drag/drop events already handled by nested editors, preserving move-only storyboard reordering. The library browser test uses a native pointer drag to cover the complete drag negotiation.

## Implementation notes (B2)

- The Settings tab groups cards by kind and reviews pending proposals with editable names, membership and covers. Proposals requiring recheck cannot be accepted until their draft differs from the proposal. Accept-all resolves sequentially and reports failures.
- The setting dialog pins up to four image-version refs from member images or host-provided canvas images, edits member roles and offers unmerge and confirmed deletion. Duplicate names link to the existing setting. An update retries one revision conflict only when the fields being saved are unchanged in the fresh view; overlapping edits display the latest setting for review.
- Script casting uses the existing `doc.set` operation with `castIds` or `styleId`. The application injects the library picker through `ScriptActions`, keeping canvas-ui independent of library-ui. The existing in-node card editor remains in canvas-ui; consolidating it with the library editor is a follow-up.
- `GroupIntoSettingDialog` backs **归为设定…** in the media selection bar.
- Image choices use the library's latest member versions and preserve already pinned refs. Screenshots cover the existing dark theme; a light theme is not implemented by the application.
- `SettingsHeader` supplies compact creation controls for the panel's tab-local header and accepts the shared merge-run controls. The tab uses the panel query. Three-column cards use 4:3 covers, compact icon metadata and count-aware copy; proposal image buttons choose a keyboard-accessible starred cover. Gallery browser coverage includes eight settings across three kinds and two proposals, one requiring recheck.
- Follow-up review (2026-11-03): updates preserve card order; closing an editor uses its already merged result. Asset events refresh pending proposals only when one of their members changed. Proposal reference lookups follow changed refs, block acceptance on failure and retain only references belonging to selected members.
- Unmerge uses the revision loaded by the editor, requires saving or discarding unsaved edits first and resets every field from the response. Conflicts preserve the draft and offer an explicit reload, superseding the automatic latest-content display described above. The script picker handles style separately from cast limits, marks the current style and labels replacement.
- Settings media share one cache per host. Since the contract has no targeted full-library-asset read, the cache retains page cursors and coalesces events for 300 ms into one read per affected page; unknown assets or rejected cursors schedule a full refresh (coordinator decision). Manual grouping checks the deduplicated existing and incoming member count before writing, including after a concurrent revision change.

## Implementation notes (C2)

- Episode numbering follows the coordinator's refined decision: default to one after the highest live episode, filling the lowest available gap only when that exceeds `SERIES_LIMITS.episode`. Explicit numbers may fill gaps; restore keeps its original number when free, otherwise uses the same default. This supersedes the initial C1 lowest-free rule.
- `SeriesView.settingCount` supplies the join checklist defaults without opening a different episode or reading its media (approved contract addition).
- The Settings tab, its newer-version count and the script picker share a settings cache per host. Series notifications coalesce for 80 ms and reread the series list plus linked settings only.
- Publish and reset operate on the saved setting revision. The editor asks users to save or discard an unsaved draft first, as for unmerge.
- Join failures remain visible per setting after project membership succeeds. Leaving and deleting a series both explain that episode settings are retained.
- Agent publish refusal is covered by the backend gateway tests; the browser acceptance uses fake Codex to list and link a series setting without adding an authentication bypass.

## Implementation notes (C1)

- Closed projects record a durable pending detach in `app.db` when leaving, changing series or deleting their series. Open projects detach immediately through their host; a closed project's next open clears its links before services or agents start. Content and copied media remain local, and replaying the detach does not bump revisions again.
- `series.mediaGet` is a UI-only host bridge returning a stored reference's path and MIME after checking its series membership. The token-protected `/series-media/<seriesId>/<refId>` route supports GET, HEAD and byte ranges. `SeriesView.settingCount` counts live settings for the join checklist defaults.
- A publication commits an immutable series revision and its request receipt before pinning the project setting. A same-request retry resumes the pin without publishing another revision. Copied ref and voice membership is tracked separately so update and reset preserve other episode members.
- Default episode numbering selects the lowest available positive number among live episodes. Restore keeps its original number when free and uses the next free number otherwise.

## UI polish (2026-11-05)

Unused-series settings headings use a normal text flow so flex gaps cannot insert spaces around the series name. Unused cards reserve enough width for the English “Use in this episode” action to remain on one line at the normal library width, while retaining a single-column fallback in narrow panels.
