# 0033 · Author skill library

Status: steps a and b implemented (2026-11-05); Windows follow-up revalidation pending (2026-11-05)

Date: 2026-11-05

Builds on [0008](0008-projects-and-workspaces.md) (project skills), [0017](0017-skill-import.md) (import, staging, script warnings) and [0027](0027-asset-library.md) (pinned copies of series settings). Revises 0017's decision not to build a global library.

## Background

- The product principle says what counts as good is the author's to define, and skills are how they package it today.
- Taste travels with a person, but a skill lives in one project's `skills/` directory. Using it elsewhere means copying it by hand, and copies drift.
- Nothing helps turn a way of working into a skill. An author must write `SKILL.md` themselves.
- The macOS sandbox denies Agents the app data directory, so Agents cannot read a library stored there.

## Goals

1. A library that belongs to the author, available in every project on this machine.
2. Saving a way of working as a skill, drafted by an Agent and decided by the author.
3. A data model that later supports syncing across devices and sharing, without redesign.

## Out of scope

Accounts, cloud sync, sharing and a marketplace (see Later), user workflows and plugins, and automatic skill updates.

## Design

### 1. Library

- Stored under the app data directory, with metadata in `app.db`: a stable `skillId` that is not the name, and immutable versions identified by content hash. Files are kept per version.
- Settings gains **My skills**: list, view, edit, import Markdown drafts, export one `SKILL.md`, delete. Editing creates a version. Deleting is recoverable, as in 0017.
- Library import accepts one or more `.md` files as untrusted drafts. The author reads, edits and explicitly saves each draft before it enters the library. No archive format or dependency is added. Existing project imports retain 0017 staging and script warnings; neither path adds permissions.

### 2. Using a skill in a project

Same model as series settings: **a pinned copy, never a live reference**.

- **Use in this project** copies a version into `<project>/skills/<name>/` with a small origin file: `skillId`, version, content hash. Agents find it through today's path, so the sandbox, the `/` picker and the Agent adapters do not change, and a project stays self-contained.
- A copy shows **newer version available** and **edited here** independently; both can apply. Update, publish back to the library and reset happen only when the author asks.
- A skill can be marked **Add to new projects**. Existing projects are untouched.
- Explicit use refuses a name clash and asks the author to rename or remove the copy. Adding defaults to a new project skips a clash and reports the skipped names; existing projects are untouched.

### 3. Saving a way of working

The author decides what their taste is. Nothing is inferred behind their back.

- The author asks, for example "save how we did this as my skill", or uses **Save as skill** in a session. Agents do not suggest this unprompted.
- New agent method `skill.proposeDraft { requestId, name, description, body }` creates a draft only. Agents cannot write to the library, and the gateway enforces that.
- Drafts open for editing in My skills, with **Save to my skills** and **Discard**; step b adds a card in the session. Saving is a UI-only action.
- The `SKILL.md` body should capture the author's stated method and reasons, in their words, without project paths or names they did not ask to keep.

## Later: across devices and sharing

Needs accounts and a service, neither of which exists, so this needs its own RFC. Constraints to keep now:

- **Local first.** The library works offline and without an account. Sync copies versions; it is never the source of truth for a project.
- **Versions, not merges.** Immutable hashed versions let devices converge by adding versions. A conflict is two versions the author chooses between.
- **Private by default.** Sharing is an explicit action per skill and version. Syncing a skill never shares it.
- **Shared skills are untrusted.** They enter through staging with script warnings, and no shared skill runs anything or gains permission by being installed. Show the author and the source.
- **Nothing secret leaves.** Provider keys are never part of a skill. Publishing scans for credential patterns and local paths and shows the result before upload.
- Exporting one `SKILL.md` gives a simple way to move a method by hand. Importing it creates an untrusted draft for author review.

## Steps

The maintainer has one or two skills, so capturing a way of working comes first and the library starts minimal.

- **a. Saving a way of working.** Library storage, `skill.proposeDraft`, guide text, and My skills with list, edit, save and discard, plus **Use in this project** as a plain pinned copy. A draft appears in My skills and the Agent says so in its reply, so this step does not touch the session panel and can run alongside RFC 0032.
- **b. Keeping copies in step.** Newer version and edited here states, update, publish and reset, Add to new projects, import and export, and the in-session draft card after RFC 0032 lands.

## Testing

- Unit: versioning and hashing, copy and origin file, edited detection, name clashes, Agent refused on library writes.
- e2e with fake Codex: use a skill in two projects, update one, draft and save, discard, and a selected skill reaching the Agent from the copy.
- No test calls a paid service.

## Decisions (maintainer, 2026-11-05)

- A library that follows the author replaces 0017's project-only rule.
- Skills will later extend to the cloud for use across devices and for sharing.
- Capture comes before library management, because few skills exist yet.

## Open questions

- Whether scripts inside skills sync and share like the rest, given they can run on another machine.

## Step a implementation notes (2026-11-05)

- `app.db` owns stable skill IDs, current revisions, version metadata, persistent drafts and a sequenced library change log. Drafts retain their originating project and session but outlive those projects. A draft is not a library entry or a project skill.
- Version identity is the SHA-256 of the exact UTF-8 `SKILL.md` bytes (JSON-quoted frontmatter and the author-approved body). Files live under `<dataDir>/skill-library/<skillId>/<hash>/SKILL.md`; metadata is committed only after the immutable file exists. Reusing identical content reuses the version; editing preserves the skill ID and all earlier version files. Unreferenced files left by an interrupted commit are never listed or installed.
- The new contract is Agent-only `skill.proposeDraft { requestId, name, description, body }`, plus UI-only `skill.libraryList`, `skill.libraryGet { skillId }`, `skill.librarySave { requestId, draftId? | skillId?, expectedRevision, name, description, body }`, `skill.discardDraft { draftId, expectedRevision }` and `skill.use { requestId, spaceId, skillId, version }`. Save requires exactly one source and checks its revision. Mutating requests with request IDs are replay-safe; proposals are also bound to the originating session. Discard is repeatable.
- The gateway requires an active turn and a linked, unarchived session for proposals. It refuses Agent calls to every library read/write, discard and project-use method before dispatch. The library guide and capability description instruct Agents to draft only on the author's request, capture their words and reasons, omit unwanted project details, and reply with the draft's name and location, **Settings > My skills**.
- Settings > My skills lists drafts and saved skills. The author edits name, description and body, saves a draft into the library or creates a new saved version, discards a draft, or discards unsaved edits. Leaving unsaved edits asks before losing them. Save does not install anything.
- Use in this project atomically exposes a plain directory copy at `<project>/skills/<name>/`, with `.vis-skill-origin.json` containing `skillId`, `version` and `contentHash` (version and hash are the same SHA-256 identity). Existing project discovery, the picker and Agent adapters read this copy unchanged. A directory or metadata-name clash, including case/Unicode-equivalent directory names, preserves existing content and asks the author to rename the library skill or remove the project copy first; no replacement operation is added in step a.
- Step a authors only `SKILL.md`; attaching other files, import/export, library deletion, copy comparison states, update/publish/reset, Add to new projects and the session draft card remain step b or later. The session panel and writing UI are untouched. Newer-version and edited-here detection are deliberately not part of this step's implementation or acceptance.
- Acceptance uses isolated temporary app/project directories, mock providers and fake Codex only. Unit tests cover hashing, stable identities, immutable old versions, persistence/replay, revision conflicts, discard, copy origins, name clashes, corruption and symlink refusal; gateway tests enforce caller and session permissions. Browser tests draft through fake Codex, edit/save/discard in Settings, pin in two projects, edit the library without changing either copy, and select/read the second project's copy in its Agent turn. Screenshots use 1600×1000 at device scale 2 under `/tmp/vis-next/rfc33`.

## Step b implementation notes (2026-11-05)

- `skill.list` adds copy state from `.vis-skill-origin.json` and SHA-256 of the current `SKILL.md`. Library version changes and local edits are independent flags, shown in My skills for the current project and the project skill list. Deleted library entries have a separate missing-entry state. Damaged frontmatter or invalid UTF-8 does not hide an originated copy: pinned metadata keeps it visible and resettable, while publish refuses invalid content.
- New UI-only methods are `skill.copyUpdate`, `skill.copyReset`, `skill.copyPublish`, `skill.setAutoAdd`, `skill.libraryDelete`, `skill.export`, `skill.importDrafts` and `skill.draftState`. Agents still have only `skill.proposeDraft`; gateway caller checks precede dispatch. Copy mutations carry `expectedHash` of the file the author saw and refuse changed bytes. Publish also checks the library revision. Update/reset confirm in the UI when discarding project edits. Only `SKILL.md` and its origin change; supplemental project files stay in place. Publishing preserves exact project Markdown bytes as an immutable version and pins the copy to that version.
- Add to new projects is an explicit per-skill flag. Project creation copies the current immutable version, returns skipped names for clashes and shows them to the author; changing the flag leaves existing projects alone. Deletion is a soft deletion in `app.db`; immutable files and metadata remain recoverable, project copies remain usable and resettable, and publish/update/use against the deleted entry are refused.
- Export downloads one `SKILL.md`. Import accepts up to 100 Markdown files, validates frontmatter, portable names and content limits, and transactionally creates drafts only. This replaces the earlier planned library archive import/export; the existing project import flow is unchanged. No scripts or supplementary files are imported through this library path.
- Draft rows retain saved/discarded status for historical session cards. Cards derive from the last actual `skill.proposeDraft` receipt, as generation cards do in RFC 0030, then reread the current draft state. All three adapters retain a structured name/description/identity receipt independently of the truncated tool log, so long bodies still produce cards. Review opens that draft in My skills; Discard is an explicit confirmed decision. The session menu's Save as skill fills an editable request without sending it.
- Library, draft, preference and copy changes append to the global skill event log. The gateway sends `events.skillsChanged { seq }` to UI connections, including connections without an open project. Clients deduplicate by sequence, reread on reconnect, and refresh open My skills pages, project skill lists and draft cards. The persisted log is independent of project deletion.
- Names reject Windows-forbidden punctuation, trailing dots and reserved device names (including extensions and superscript device digits), in addition to existing path/control-character checks.
- Verification uses isolated app/project directories, mock providers and fake Codex. Unit tests cover simultaneous states, hash refusal on all three copy mutations, exact-byte publishing, pinned reset, deletion, defaults/clashes, draft-only import, persisted draft decisions and receipt placement; gateway tests refuse Agents on every added method. Browser coverage exercises confirmations (cancel and accept), update/publish/reset, defaults in a new project, Markdown import/export, deletion, and a session card changing from draft to saved. Evidence is under `/tmp/vis-next/rfc33b` at 1600×1000 with device scale 2.

## Evaluation notes (2026-11-05)

The third real Codex evaluation drafted a body with its own frontmatter and added cautions the author never gave. `skill.proposeDraft` now refuses frontmatter in `body` (`skill.draft_frontmatter`), and the guide says to keep to what the author stated and ask about gaps. Fidelity stays the author's call at review; it has not been rerun against a real Agent.

## Windows copy replacement follow-up (2026-11-05)

Implementation fixed; Windows open-handle acceptance pending. Update/reset reuse Ark's atomic Windows rename retry policy, now shared through assets: eight attempts with seven waits of 10–640 ms (1.27 s total). The synchronous transaction uses bounded waits and rechecks `expectedHash` before every attempt, preserving edits made by another application during a wait. Persistent `EPERM` becomes localized `skill.copy_file_locked`, asking the author to close SKILL.md in other applications and retry. The original bytes and origin metadata remain unchanged on that failure, and temporary replacement files are removed. Tests inject Windows locks for both operations and verify successful retry after release; actual Windows file-sharing flags still require rerunning the maintainer's reproduction.
