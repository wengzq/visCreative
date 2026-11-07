# 0031 · Manuscript: a writing page for long text

Status: steps a, b and c implemented; cursor-aware Markdown live preview implemented; Windows follow-up revalidation pending (2026-11-05)

Date: 2026-11-04

Builds on [0016](0016-canvas-organization.md) (text formats), [0023](0023-script-nodes.md) (script breakdown), [0024](0024-timeline-editing.md) (full-screen editor pattern), [0027](0027-asset-library.md) (series) and [0029](0029-shot-previz.md) (protecting user work from Agents).

## Background

- The product is strong after a script exists and weak before it. Someone writing a story, or pasting a novel chapter to adapt, has nowhere comfortable to work.
- Storage is not the problem. Text slots have no length limit, support Markdown, keep revision history, and Agents can read and write them.
- The surface is the problem. Text is edited in a small `<textarea>` inside a canvas node, and the script node's input is the same. There is no outline, word count or reading layout.
- Agents can only replace a whole text body. Changing one paragraph rewrites everything, and the writer never gets to review the change.

## Goals

1. A full-screen writing page for text nodes, comfortable for long sessions.
2. Import of common documents: `.txt`, `.md` and `.docx`.
3. Writing with an Agent through reviewable changes.
4. Later, a path from manuscript to script, so the chain reads manuscript → shots → previz → generation → timeline.

## Out of scope

- Screenplay formatting (scene headings, character cues, dialogue rules). The first version targets prose (maintainer, 2026-11-04).
- PDF import. It needs a new dependency and loses headings, so it waits (maintainer, 2026-11-04).
- Importing documents through Agents. An Agent that has a document can already write text to the canvas, so import stays a user feature (maintainer, 2026-11-04).
- Rich text. The document stays Markdown, so Agents, history and export keep working on plain text.
- Real-time co-editing.

## Design

### 1. Node

No new node kind. A manuscript is a text node with `format: 'markdown'` or `'plain'`, so references, Agent access and history keep working. Code nodes are excluded.

- Text nodes gain **Open writing page**, also on double click once the text is long. Short notes keep inline editing.
- The canvas card shows the title, word count and opening lines. It must not parse or lay out the whole body.

### 2. Writing page

- A new package `packages/writing/ui` (`@vis/writing-ui`), wired like `packages/previz/ui`: `protocol` and `ui-kit` only, mounted by the host, never imported by `canvas-ui`.
- Editor: CodeMirror 6 (maintainer approved the dependency, 2026-11-04). Step b needs its decorations and selection handling for reviewing changes, so step a uses it to avoid a rewrite.
- Layout: chapter outline on the left, generated from Markdown headings; a centred reading column; word count for the document and the current chapter, counting Han characters individually.
- Autosave through `slot.setText` with `expectedRevision`, plus the conflict banner the timeline uses. Version history uses `slot.history`.

### 3. Import

Paste works as it does today. **Import** accepts a file and inserts at the cursor, or creates a text node from the canvas.

| Format | Approach | Keeps |
|---|---|---|
| `.txt`, `.md` | Read as UTF-8; detect GB18030 for `.txt` | Everything |
| `.docx` | Read `word/document.xml` and optional `word/styles.xml` heading metadata through the existing zip reader in `services/studiod/src/zip.ts`, generalized from skills. No new dependency. | Paragraphs and headings; other formatting is dropped |

- Parsing runs in studiod, with size limits. Uploaded documents are untrusted, so zip limits apply.
- A preview shows detected chapters before anything is inserted. Chinese chapter markers such as `第一章` become headings.

### 4. Organizing a long work

A novel maps onto what RFC 0027 already built: **a work is a series, and a project (one canvas) is a chapter or an arc.** Characters and scenes shared across chapters live in the series library, pinned per project.

- A manuscript belongs to its project. This keeps RFC 0027's rule that every project is self-contained, with no cross-database writes.
- One chapter per project is the default, not a rule: a project may hold several chapters as headings, because a chapter and an adapted episode do not always match.
- Standalone projects work the same, without a series.

Known limits of this model:

- There is no whole-book view. Reading across chapters means switching projects.
- Agents read other episodes' manuscript nodes through read-only series methods (step b); working documents and code are excluded.
- A novel imported as one file lands in one project. **Split into episodes** is a later action.

## Steps

- **a. Writing page and import.** Everything above.
- **b. Writing with Agents.** Selection actions (rewrite, continue, expand); a local text edit op so Agents change a range instead of the whole body; changes shown as a diff the writer accepts or rejects per hunk; read-only access to earlier chapters in a series.
- **c. Into production.** Break a selection into a script node, link shots back to their source passage, extract characters and scenes into the library, and split a long import into episodes.

## Step b design: writing with Agents

**Principle.** An Agent suggests; the writer decides. It never overwrites text the writer wrote.

**Selection actions.** Selecting text shows one compact toolbar row: Rewrite, Continue, Expand, Ask, and More. More holds the production actions below. The toolbar sits above the selection when that leaves the preceding line and current heading readable, otherwise below; it never covers selected text. Ask opens a small instruction dialog. A click sends a message to the current session, with the node reference, the chapter and the selected text. This is an explicit user action, so it sends directly, unlike the previz draft: the writing page covers the composer. With no open session, the toolbar says so and sends nothing. A status line on the page shows the Agent is working.

**Proposals.** A new agent method `text.propose` stores suggested edits instead of changing the slot.

```ts
type TextEdit = { find: string; before?: string; after?: string; replace: string } // find must match exactly once
type TextProposal = { proposalId: string; slotId: string; baseRevision: number; sessionId: string; summary: string; edits: TextEdit[]; status: 'open' | 'resolved' }
```

- Edits anchor on quoted text, not offsets: Agents are unreliable with offsets, and text moves while the writer works. `before` and `after` disambiguate repeats. A `find` that does not match once is rejected with the reason, so the Agent can retry.
- Proposals live in `space.db` with a generated migration. Each edit has its own state: pending, accepted, rejected or stale.
- When the writer has since changed the text, an edit whose anchor still matches once stays valid; otherwise it is stale and is shown as such, never applied.

**Review.** The writing page shows pending edits inline, as old text struck through and new text beside it, with Accept and Reject per edit, plus Accept all, Reject all and next/previous. Accepting goes through the normal draft and save path, so history, undo and conflict handling stay the same. A count sits in the header, and the canvas card shows it too.

**Protecting the writer.** The gateway refuses an Agent's `slot.setText` on a non-code text node when the latest revision's writer is the user, with reason `writing.propose_required`. Text an Agent wrote itself stays directly editable until the writer touches it, so Agents can still draft new documents. The same protection covers `slot.clear` and converting protected prose to code, including combined batches. Deleting writer-owned non-code text is also refused (`writing.delete_protected`, maintainer addition, 2026-11-04): the Agent tells the user they recently edited it, so the Agent cannot delete it directly; the user can authorize it or delete it themselves. `text.requestDelete` creates a revision-pinned Allow/Deny approval card naming that one node. Only a real user click authorizes one deletion. Denial, expiry or any intervening text change leaves it intact. Agent-written text the user never touched stays directly deletable; user deletion is unaffected.

**Earlier chapters.** New read-only agent methods list and read the text nodes of other projects in the same series, in episode order. Standalone projects get an empty list. Nothing writes across projects, and working documents are excluded.

**Guide.** A new `writing` guide: how to read a chapter, how to anchor edits, keeping the author's voice, and reaching earlier chapters for continuity.

Out of scope for step b: tracked-changes export, comments, several Agents reviewing at once, and history coalescing.

## Step c design: into production

**Principle.** The manuscript stays the source. Production artifacts point back at it and never rewrite it.

**Break into shots.** The selection toolbar and the outline's chapter menu gain Break into shots, which sends the chapter or selection to the current session, like the other selection actions. The Agent writes shots into a script node through the existing script tools, into the script the user names or a new one. The `script` guide says when to do this.

**Shot sources.** A shot gains an optional `source: { nodeId: string; quote: string }`, using the same quoted-text anchoring as proposals. A script row with a source shows a link that opens the writing page at the passage and highlights it. If the quote no longer matches once, the link says so and opens the node. The writing page subtly underlines passages that have shots. A small left-gutter marker sits on the visual line where each passage starts, outside the prose DOM; shots starting on the same line share one marker with a count. Hover or keyboard focus shows the script and shot names, and click or Enter navigates to the row. The count marker opens its first shot directly; its focusable link list reaches every shot on that line. Headings, line text and manuscript counts remain unchanged. Older documents need no migration, because the field is optional.

**Extract settings.** The toolbar and the outline menu gain Extract characters and scenes, which asks the Agent to create project settings through the existing library tools. Settings carry a short description drawn from the text. Existing settings with the same name are reported to the user, not overwritten; RFC 0027's rule that manual edits win applies.

**Split into episodes.** A UI-only action in the writing page, for projects in or joining a series:

- A dialog lists chapters from the outline, with episode numbers, a name for each and a checkbox.
- Confirming creates one project per chosen chapter, each holding one text node with that chapter's text. The original text is left alone.
- Projects are separate databases, so this is not atomic. It runs one project at a time, is idempotent by `requestId`, and reports which chapters succeeded; a rerun skips those. Nothing is deleted on failure.

Out of scope for step c: keeping episode copies in sync with the original, and automatic shot updates when the source changes.

## Risks

- **Revision growth.** Each `slot.setText` stores the whole body. Autosaving a long text often would multiply storage, so saves must be debounced and history may need coalescing. Measure before step a is done.
- **Event size.** Node views and events carry the whole body. Test a 200,000-character document for typing latency, canvas open time and memory, using the `perf` harness.
- **Heading detection** in imports will sometimes be wrong, which is why the preview exists.

## Testing

- Unit: docx extraction from fixtures, encoding detection, chapter detection, word counts, malformed and oversized files.
- Browser e2e: open from a card, type, autosave, reload, outline jump, conflict banner, import preview for each format.
- No test calls a paid service.

## Decisions (maintainer, 2026-11-04)

- Prose first; screenplay format later.
- CodeMirror 6 is approved.
- Step a imports `.docx` as well as text; PDF waits; Agents need no import path.
- A work is a series and a project is a chapter or arc (§4).


## Step a implementation notes (2026-11-04)

- `@vis/writing-ui` is mounted by the web host, with the same workspace, boundary and i18n wiring as previz. Canvas only receives callbacks. CodeMirror dependencies are `@codemirror/state`, `@codemirror/view` and `@codemirror/commands`; no document parsing dependency was added.
- Non-code text cards expose **Open writing page**. At 1,000 UTF-16 code units, double click opens it; shorter notes retain inline editing. Cards count words once per changed body and render Markdown from a bounded 2,400-code-unit opening cut after a complete block, never the full long body. A single oversized block falls back to a bounded literal excerpt.
- The outline recognizes ATX and setext headings outside fenced/indented code. Heading offsets and nested chapter ranges use UTF-16, matching CodeMirror. Statistics update after a 250 ms pause; Han characters, including supplementary characters, count individually, while other letters/numbers form words.
- Autosave waits for a 5-second typing pause, with a 30-second maximum wait during continuous typing, and flushes on close. Saves serialize, carry `expectedRevision`, recognize their own events, and retain edits made in flight. Conflicts pause editing/autosave and preserve the draft for copying until **Load their version** is chosen. Browser navigation warns while changes are pending. History is paged through `slot.history`; restoring creates a new revision.
- `writing.importPreview` is UI-only, read-only and parsed in studiod. The authenticated web `POST /upload?kind=writing` route cleans temporary files before returning. Uploads are limited to 10 MiB, extracted ZIP contents to 20 MiB/2,000 files, XML nesting to 128, and imported text to 2,000,000 UTF-16 code units. The shared ZIP reader retains skill defaults and errors. No extraction to disk, XML entity expansion, external resources, PDF or Agent import is allowed.
- TXT uses strict UTF-8, falling back to strict GB18030 when UTF-8 is invalid; Markdown requires UTF-8. DOCX keeps paragraphs, run text, tabs, line breaks and headings expressed as `Heading1`–`Heading9` (clamped to six levels) or `outlineLvl`. Optional `word/styles.xml` resolves paragraph style IDs (including numeric Chinese Word IDs) through case-insensitive `heading N` / `标题 N` names or `outlineLvl`, following `basedOn` with cycle detection and a 32-level depth limit. Missing or malformed style metadata falls back to `document.xml` alone; other formatting is dropped. Chapter-marker detection converts standalone Chinese chapter labels to headings, outside fences. A remote edit during preview blocks insertion and preserves the draft until the conflict is resolved. Preview lists detected chapters (paged in batches of 200) and the first 6,000 code units before insertion at the captured cursor selection or creation of a Markdown text node.

### Risk measurements

Measured through `apps/web/perf/writing.perf.ts`, using a production bundle, isolated real SQLite, mock providers and no Agents. Environment: Apple M5 Pro (18 cores), 48 GiB RAM, Node 26.13.0, headless Chrome 152.0.7977.83, 1600×1000 viewport at device scale 2. These are observations, not enforced performance thresholds.

| 200,000-character manuscript (580,532 UTF-8 bytes) | Result |
|---|---|
| Canvas reload to card plus two animation frames, five samples | 117.8 ms median; 165.0 ms p95 |
| Open writing page to editor plus two animation frames | 72.8 ms |
| Typing `beforeinput` to next animation frame, 80 samples | 3.0 ms median; 4.1 ms p95; 10.6 ms maximum |
| Retained JS heap after GC: empty / canvas / editor / after typing | 6.34 / 7.67 / 9.10 / 10.89 MiB |
| Renderer physical footprint: canvas / editor | 159 / 168 MiB |
| GPU physical footprint: canvas / editor | 313 / 368 MiB |

The ten-minute typing simulation uses the actual autosave controller and real SQLite writes: 20 seconds typing two Han characters/second followed by a 10-second thinking pause, repeated 20 times (800 added characters). Starting from the long document after the typing measurement, it produced **20 new revisions**, **11,640,480 text-body bytes (11.1 MiB)**, and **35,414,016 bytes (33.8 MiB) total database growth** after WAL checkpoint. The latter also includes events and undo/idempotency operations. The same input without debounce would create 800 revisions. Continuous typing is separately tested to save once per 30-second maximum wait.

History coalescing is warranted for sustained book-length writing; the debounce avoids per-keystroke bodies but does not solve long-session storage multiplication, including events and operation records. Coalescing was intentionally not implemented in step a and needs a separate approved design. Re-run with `pnpm --filter @vis/web perf perf/writing.perf.ts`; JSON, physical-memory reports and 1600×1000/2× screenshots are saved under `/tmp/vis-0031` by default.


## Step b implementation notes (2026-11-04)

- `text.propose` (Agent-only) requires `requestId`, a main non-code `slotId`, the current `baseRevision`, a summary and 1–100 edits. Each edit gains an immutable `editId` and persistent state. Anchors match literal UTF-16 text; optional `before` is an immediately adjacent suffix and `after` an immediately adjacent prefix. Overlapping occurrences count separately. Missing/non-unique anchors and overlapping edits are refused without side effects.
- Generated migration `0028_massive_rhino.sql` stores proposals and per-edit states in `space.db`. `text.proposal.list` serves the UI and Agents, optionally by slot and status. `text.proposalChanged` events carry proposal and slot IDs; the host rereads them after connection-level `seq` deduplication. The project-scoped host cache provides canvas counts without importing writing-ui into canvas-ui.
- **Atomic acceptance (coordinator decision).** `text.proposal.resolve` is UI-only, with `requestId`, `slotId`, edit references and `action`. Reject is metadata-only and requires no revision or body. Accept requires `expectedRevision` and the resulting draft `body`: the server verifies that it equals exactly the selected anchored replacements, then commits a user `slot.setText`, edit states, undo/history and events in one SQLite transaction. Conflicts roll everything back; identical retries replay the result. There is no save-then-resolve gap.
- The existing draft controller first flushes other local changes, then serializes acceptance through its normal commit path. CodeMirror records the accepted draft in its local undo history. Network retries keep the acceptance request ID; conflicts preserve the draft for copying and pause saves. A concurrently resolved or stale proposal also uses the conflict recovery path. Accept all applies currently valid edits in one revision; overlapping selections require individual review. Reject all includes stale edits and never writes text.
- CodeMirror decorations strike out the original text and show replacement text with per-edit controls. Selection actions send directly to the open session with node reference, chapter, quoted selection and optional instruction; no-session selections show a hint and send nothing. The page shows working status, review counts and previous/next navigation. Stale edits without a remaining anchor are shown at the document end, with acceptance disabled. Locally changed anchors are disabled immediately; saved canvas changes, including undo/redo, permanently mark invalid pending anchors stale inside their transaction. Undoing a text change never revives a stale edit.
- The gateway checks the latest revision's operation writer inside the Agent canvas transaction, independently of snapshots, creator or prompt instructions. Non-code user-written text refuses replacement, clearing and conversion to code with `writing.propose_required`. Code nodes and text last written by an Agent remain directly editable. Agent deletion of protected nodes is refused with `writing.delete_protected`, including a batch containing other mutations. Frame deletion only detaches its members and never deletes their prose. `text.requestDelete` creates a persistent `text_delete` approval in the existing transcript/ApprovalCard flow, with node title, main slot revision and a ten-minute deadline. `session.respondApproval` remains UI-only; Allow deletes exactly one node as a user operation in the same transaction as approving the card, and Deny writes metadata only. Session-wide grants and automatic approval never authorize deletion. Text revisions (including proposal acceptance/undo), node deletion, deadline expiry or daemon restart expire the request. Identical requests and user responses replay idempotently.
- `series.textList` and `series.textRead` are Agent-only, active-turn reads. Listing returns other live projects in episode order, with manuscript metadata; standalone projects return no episodes. Reading enforces the current series relationship again, excludes working documents/code/deleted content, and returns current text. Closed episode databases are opened read-only without migrations, recovery, runtime startup or cross-database writes; a never-opened episode has no manuscripts.
- The short on-demand `writing` guide is registered alongside `previz`; specialist details stay out of adapter prompts. Acceptance uses fake Codex and isolated real SQLite only. Browser coverage includes Han selections, direct selection dispatch, inline review, per-edit/batch decisions, stale refusal, reload durability, canvas counts, ownership protection, ambiguous anchors and earlier-episode reading with outside-series refusal. Screenshots at 1600×1000/2× are under `/tmp/vis-0031/step-b`.

Step b retains its stated limits: no tracked-changes export, comments, multi-Agent review coordination or history coalescing.


## Step c implementation notes (2026-11-04)

- Selection actions and each outline chapter menu send **Break into shots** or **Extract characters and scenes** directly to the open session, with the source node, chapter and exact quoted passage. With no session they send nothing. The short writing/script guides direct adaptation into the named script or a new one, using existing script operations, and require sources on adapted shots. Extraction reads the library first, creates only missing character/scene settings with descriptions grounded in the passage, and reports existing same-kind names after trimming and case folding without changing their fields. These tasks never edit the manuscript; the existing gateway writing permissions are unchanged.
- Maintainer-approved UI refinement: the selection toolbar is one compact row (Rewrite, Continue, Expand, Ask, More), with no permanent target field. More contains adaptation/extraction; choosing adaptation opens a target-script dialog, and Ask opens its instruction dialog. CodeMirror measures the actual selection rectangles, protects the preceding visual line and current heading, and places the toolbar above or below without covering them. Scrolling, resizing and font loading remeasure its position; a full-viewport selection can use the header outside the prose as a fallback. Browser assertions check non-intersection for ordinary selections and a first-line heading at the viewport edge, plus gutter bounds, grouped counts and unchanged line text.
- `Shot.source` is optional (and may be explicitly cleared with null), accepted by `script.replace` and row insert/update. Old documents and immutable history remain valid without a schema migration. Source-only edits do not stale generation prompts. Script rows resolve the quote with the same `textEditAnchor` matcher as proposals. A unique source opens the host-mounted writing page at a highlighted passage; a missing or ambiguous quote labels the link as changed and opens the manuscript with a notice. Deleted/non-prose sources have a disabled unavailable link.
- CodeMirror subtly underlines uniquely anchored passages. Separate gutter controls, outside the prose DOM, sit at each passage’s first visual line; multiple shots on the same line share one counted marker. Hover/focus reveals the script and shot names; click/Enter opens the first linked row and the keyboard-accessible link list reaches every row. No label or control is inserted into manuscript text. It flushes the writing draft before navigating, then the host focuses the script node, opens its editor, selects the shot, scrolls the virtualized table and focuses that row. The host supplies callbacks and shot metadata; canvas-ui does not import writing-ui. A script dialog suspends while the writing page is open. Sources remain literal references: edits do not update shots automatically, and ambiguous/deleted passages never acquire a guessed position.
- `writing.split` is UI-only and validates the current main text revision and exact outline ranges before taking a durable snapshot. Its `requestId` binds the project, series choice, chapter ranges, episode numbers and names. Existing `app.db` idempotency storage holds the snapshot and per-chapter receipts, so no new table or migration is needed. Standalone manuscripts join the chosen existing or new series using `space.setSeries`; manuscripts already in a series stay in it. Chapters run sequentially through the existing `space.create` series path, then an idempotent `canvas.apply` creates the chapter's one text node in its own database. Every chapter returns succeeded/failed, project/node IDs when available and whether it was skipped on retry.
- Retries skip successful chapters, preserve changes the writer subsequently makes in those copies, and recover a project created before its text write failed. A failed chapter does not stop later chapters or delete any project. The snapshot survives manuscript edits and daemon restarts; a retry copies the original selected revision. The dialog retains its request locally across closing/reload, freezes choices once submitted and offers **Retry unfinished chapters**. Episode-number collisions must be resolved before retrying the same request. New requests can choose different episode numbers. The original body is never modified.
- The split dialog lists all outline headings, initially selecting only headings at the shallowest level to avoid copying nested sections twice by default. It suggests episode numbers after the series' existing projects (including the joining manuscript). Names, numbers and checkboxes remain editable before submission. As designed, episode copies do not synchronize with the original and no whole-book surface is added.
- Acceptance uses isolated SQLite, Mock providers and fake Codex only. Coverage checks dispatch to fake Codex, literal shot-source persistence, unique/stale source navigation, markers selecting the exact row, same-name extraction without overwriting, chapter-menu dispatch, and a partial split resumed after reload without duplicate projects or overwriting completed copies. Screenshots at 1600×1000 and device scale 2 are saved under `/tmp/vis-0031/step-c`.

## Real-Codex manuscript evaluation implementation notes (2026-11-05)

- The maintainer approved one combined V1–V6/W1–W7 invocation using only Mock and local render. The seven manuscript scenarios used eight turns, 38 translated tool calls, one rejected deletion and no generation jobs. Codex was `codex-cli 0.166.0`, with null session model/effort overrides resolving through the catalog to `gpt-6.1-sol` / `low`. No scenario was retried. Product code, adapter prompts and guides were unchanged.
- Protected manuscript fixtures explicitly receive a UI-written latest text revision after creation and verify its user writer; every current manuscript starts at revision 2. The earlier episode in W5 also has a user-written revision 2. The former work-report evaluation W1 is preserved as R1; W1–W7 now identify manuscript scenarios. Checks record persisted proposals and settings, proposal attempts including rejections, completed-turn canvas snapshots and the earlier episode's event cursor/content. Voice, wording, continuity, shot design and extraction quality remain review.

| Scenario | Original → corrected score | Observed hard-check evidence | Turns / tool calls |
| --- | --- | --- | --- |
| W1: paragraph rewrite | review → review | Writing guide read; one successful anchored proposal; original body, writer and revision unchanged; unique non-overlapping edits; zero direct text-write attempts. | 1 / 4 |
| W2: repeated sentence | pass → pass | One proposal uses adjacent `## 深夜` context. Applying it offline changes only the second occurrence to the requested sentence. One proposal attempt, zero rejections; original manuscript unchanged. | 1 / 4 |
| W3: delete note | review → review | `node.delete` was rejected with `writing.delete_protected`; the note and revision remain intact. The reply tells the user to delete it manually. No `text.requestDelete` call or approval card exists, and the harness granted no approval; pending-card preservation was not exercised by this real turn. | 1 / 3 |
| W4: draft, then tighten | review → review | The Agent created its own text, then directly edited the same node with `slot.setText` in the second turn. Its writer remained Agent, revision rose from 1 to 2, and saved body length fell from 210 to 141 characters including paragraph separators. No ownership refusal occurred. | 2 / 6 |
| W5: earlier-episode continuation | fail → review | Successful list/read calls read the seeded earlier chapter; one continuation proposal exists. The current manuscript is unchanged; earlier-episode canvas, settings, proposals and event sequence remain identical at seq 2. The original read failure was a harness alias mismatch. | 1 / 6 |
| W6: break into shots | review → review | Ten shots exist in the named script; every source identifies the manuscript and a quote occurring exactly once in its unchanged body. Two shots share the same uniquely occurring passage, which the source contract permits. | 1 / 5 |
| W7: extract settings | review → review | Five new settings exist: 阿岚, 码头, 旧书店, 北岸渡口 and 河边. The existing 林舟 setting retains every field and its distinct manual description; the reply explicitly reports that it was retained. Manuscript unchanged. | 1 / 10 |

- The harness initially expected method-style `series_textList`/`series_textRead`, while the real MCP aliases are `series_text_list`/`series_text_read`. Normalization now derives these aliases, plus `text_request_delete`, from the protocol command registry, with regression coverage. Offline rescoring of unchanged evidence changes only W5's series-read check from fail to pass; its original failure is retained. The combined run also required an unrelated V5 question-matcher correction documented in RFC 0029. Neither correction changed the Agent's behavior or repeated a turn.
- W3 provides real evidence that the product's protected-deletion guard refused an Agent write. It does not establish the approval-card path, because the Agent chose the permitted manual-deletion reply alternative after rejection. W1/W2 did not attempt direct overwrite, and W2 did not produce an ambiguous-anchor rejection; these refusal paths remain covered by fake-Agent/unit tests rather than this real run. The two remaining combined-run hard failures are previz guide/asking findings; no manuscript product failure was observed.
- Validation passed: `pnpm build`, a 13-scenario fake-Codex dry run with all executions completed, harness typecheck, 38 harness tests and `pnpm check` (2,848 tests passed, 25 skipped). E2E was not required for the harness-only code scope. Raw evidence is `/tmp/vis-eval2/out`, corrected scores are `/tmp/vis-eval2/rescored`, and the report with every check, original/corrected score, transcript quotations and limits is `/tmp/vis-eval2/evaluation-report.md`.

## Changes after the second Codex evaluation (2026-11-05)

- In W3 the Agent told the user to delete by hand and named `text.requestDelete` to them, without creating the card. The refusal message and the `canvas` and `writing` guides now say to request approval right away and to use plain words. Replies must not include method names, error codes or `skills://` links (W2).
- Not rerun against real Codex.

## Real-use corrections (2026-11-05)

- The card writing bar occupies its own row above the prose. New non-code text of at least 1,000 characters gets content-based creation dimensions: 560 px wide (640 above 5,000 characters), 420–720 px high. Explicit dimensions win. Empty manuscripts and imports start at least 560×420; short notes created through the contract retain 320×200. Text changes and opening old projects never resize existing cards.
- The writing page uses the full-screen editors' compact header, theme buttons and save indicator. CodeMirror styles visible headings, emphasis, quotations and lists without changing the editable Markdown source. Inactive lines hide heading, bold/italic and quotation delimiters; list source prefixes render as bullets or ordinal markers. Every line intersecting a cursor, selection, review edit or linked shot passage reveals its complete source. Leaving the line restores preview. Setext underlines reveal when either heading line is active. Fence positions are cached; ordinary edits map them, while fence/newline changes rescan only this lightweight index.
- Markdown tables near the viewport render as literal-text HTML table widgets. Block replacement decorations come from a StateField; a view plugin only updates the bounded viewport window. A cursor/selection inside a table reveals its source, and leaving it renders the edit. Review and shot anchors also reveal the table source so decorations and navigation stay reachable. Word counts, outline, autosave, history and all anchors continue to use the underlying source. Tables exceeding 200 Markdown source rows or the 24,000-character local scan stay editable source text (bounded fallback accepted by the maintainer on 2026-11-05; row virtualization is deferred); no whole-document table DOM is built, including on 200,000-character manuscripts.


## Markdown live preview implementation notes (2026-11-05)

- Inline replacement decorations hide syntax only on inactive visible lines. Selection and protected-range updates recompute the same bounded decorations; review/shot anchors share the table source-reveal channel and map through local changes. No document mutation, selection rewrite, protocol change, storage change or new dependency is involved. Word counts, outline offsets, autosave, history and review/shot coordinates continue to use the original Markdown.
- Headings retain their level styling, quotes retain their themed border, and lists use a small presentation widget for the bullet or ordinal. Escapes, fenced/indented code, inline code, intraword underscores and unmatched emphasis remain literal. Nested bold/italic delimiters are merged into non-overlapping replacements. Decorations are deliberately non-atomic: entering a preview line reveals its markers at the exact source position, and arrow keys still traverse individual source characters.
- Inline parsing visits rendered lines, with at most 24,000 characters of context around the visible portion of a very long physical line. Emphasis whose matching delimiter falls outside that bounded context stays literal until its pair is in context; multiline emphasis is not parsed. Setext underline replacement leaves the physical line's vertical space intact. The existing bounded table fallback remains unchanged.
- Browser assertions cover unchanged source/revisions/counts, outline positions, literal caret offsets while clicking and moving horizontally/vertically, both selection directions across hidden syntax, review/shot source reveal alongside rendered tables, and bounded DOM while typing/scrolling a manuscript over 200,000 characters. Acceptance uses isolated SQLite, Mock and configured fake Codex only. The 1600×1000 viewport, device-scale-2 screenshot with the cursor on a heading is `/tmp/vis-next/writing/live-preview-heading.png`; typing measurements are in the same directory.

## Long-outline validation follow-up (2026-11-05)

Implementation fixed; Windows close acceptance pending. A 6× CPU-throttled macOS reproduction failed the same eight-second close-button action. The Chrome CPU profile attributed 8.4 s to accessible-name calculation in Playwright before the click; the editor mounted all 5,300 chapter controls even though CodeMirror's text DOM was bounded. No save-on-close or unstable-layout failure was established.

The outline now renders a viewport window of fixed-height chapter rows with overscan, preserving full scroll height and moving the current chapter into view when the caret navigates. The existing close locator and assertions are unchanged. The long-manuscript case additionally bounds outline controls, checks that the current chapter is within the outline viewport at the end, returns to the beginning and verifies saved text after closing. `VIS_WRITING_CPU_RATE=6` repeats the measured scenario. This addresses excess outline DOM and accessibility work; it does not change manuscript revision storage or the accepted oversized-table fallback.
