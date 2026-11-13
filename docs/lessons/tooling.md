# Tooling lessons

## Media paths for the daemon do not reach Agent shell tools

- **Symptom:** packaged media jobs succeed but an Agent shell reports ffmpeg missing on a machine without a separate installation.
- **Cause:** studiod uses explicit media paths while Agent environments keep only their allowlisted login-shell PATH.
- **Instead:** derive the configured media directory once in studiod and pass it to the shared Agent PATH helper: vis first, user tools next, bundled fallback last without duplicates. Keep Electron flags outside the allowlist. Test a real sandboxed shell resolving both bundled tools and encoding a lavfi clip with adjacent dylibs, rather than only checking a policy string or daemon media jobs.
- **Found in:** [RFC 0046 Agent media PATH](../rfc/0046-desktop-app.md#as-built-step-c1-2026-11-13), `agent-path.test.ts` and the packaged smoke.

## A smaller media package still needs an exact source offer

- **Symptom:** shipping exact source archives made the preview much larger; simply excluding them would remove the source-access information.
- **Cause:** build output and application runtime contents served different purposes but shared one directory copy.
- **Instead:** retain c2's archives for separate hosting, exclude only `source/` from app staging, and generate `SOURCE-OFFER.txt` from the same `BUILDINFO.json` component versions, licences and SHA-256 values. Keep licences and build metadata in the app, guard against source-directory reintroduction, and require the configured source URL plus exact recipes in d1's release workflow. Local previews may use the maintainer-approved on-request wording with a warning until that host is chosen.
- **Found in:** [RFC 0046 source-hosting decision](../rfc/0046-desktop-app.md#as-built-step-c1-2026-11-13), `ffmpeg-source-offer.test.ts`.

## A failed capability probe is not a permanent capability result

- **Symptom:** installing ffmpeg or recovering from a busy encoder left local operations unavailable until studiod restarted.
- **Cause:** the shared encoder detector cached its rejected promise indefinitely.
- **Instead:** share concurrent probes and cache successful results, but evict the exact cached promise on rejection. Keep compatibility order in one exported constant, use it for trim/render/mock and their preflight, and reserve hardware-first selection for timeline export. Never mutate cached quality arguments to customize a renderer's CRF.
- **Found in:** [RFC 0046 packaging review](../rfc/0046-desktop-app.md#as-built-step-c1-2026-11-13), `encoders.test.ts` and `lgpl-encoding.test.ts`.

## Package staging needs an explicit target and executable boundary

- **Symptom:** a linked `vis` launcher lost its app directory, a standalone pnpm binary was parsed as JavaScript, or a second architecture target reused the first target's native files.
- **Cause:** resolving only `$0`'s directory, treating every package manager as a Node script, and deriving output targets independently of staged native dependencies.
- **Instead:** resolve symlink chains before the launcher's relative paths; run JS entries through Node and other executable entries directly; record the staged target and reject conflicting builder arguments. Test the launcher through absolute and relative links and execute a real native binary in the package-manager dispatch regression.
- **Found in:** [RFC 0046 packaging review](../rfc/0046-desktop-app.md#as-built-step-c1-2026-11-13), `scripts/desktop-packaging.test.ts`.

## Test cleanup must retain ownership checks through its fallback

- **Symptom:** multiple `lsof -t` lines produced NaN, or a shutdown failure skipped temporary-directory removal and left the daemon alive.
- **Cause:** assuming one open-file PID and putting cleanup only after successful RPC/wait operations.
- **Instead:** filter all candidate PIDs by the app executable and daemon entry, bound shutdown, and use `finally` for owned-process termination and cleanup. Revalidate the isolated lock before signalling to avoid PID reuse; retain data when stopping the process cannot be confirmed. Test failed and hung RPCs, SIGTERM escalation, and a process that cannot be stopped.
- **Found in:** [RFC 0046 packaging review](../rfc/0046-desktop-app.md#as-built-step-c1-2026-11-13), `apps/desktop/src/process-helpers.test.ts`.

## Bundled-media acceptance must also disable login-shell PATH import

- **Symptom:** a packaged-media smoke test can still find Homebrew ffmpeg after its parent PATH was stripped, or unit fixtures ignore `VIS_FFMPEG_PATH` and run the system tool.
- **Cause:** the desktop app intentionally imports PATH from the login shell; direct adapter tests and older fixture subprocesses invoke `ffmpeg` by name instead of studiod's environment wiring.
- **Instead:** for the isolated packaged gate use a system-only PATH and a shell that exits without returning a login PATH, then require the bundled ffmpeg and assert no system executable is available. For direct provider tests, set `VIS_FFMPEG_PATH` and prepend that same bundle directory to PATH so fixture calls use it too. Fixture input clips can use MPEG-4; composition tests should use the detected encoder rather than require GPL libx264, while keeping pixel and alpha assertions.
- **Found in:** [RFC 0046 c1/c2 integration](../rfc/0046-desktop-app.md#as-built-step-c1-2026-11-13), `apps/desktop/e2e/packaged.e2e.ts` and `render-provider.test.ts`.

## Electron installation and packaging need separate native dependencies

- **Symptom:** a fresh install has no Electron binary, or a packaged app fails to load SQLite while the source app works.
- **Cause:** pnpm's build-script allowlist omitted `electron`, and the source and Electron runtimes can have different native-module requirements. Electron 45 also installs its binary lazily on first use rather than through a postinstall script, so that first launch may include a download.
- **Instead:** allow `electron` in `onlyBuiltDependencies`. Stage a real copy of better-sqlite3, remove all prebuilds, compile against the selected Electron headers with the target architecture, and keep only its runtime JS and rebuilt addon. Never rebuild pnpm's shared source dependency in place. Set the packaging Electron cache explicitly in `electronDownload.cache`; the installer's `electron_config_cache` environment variable alone does not relocate electron-builder's downloads.
- **Found in:** [RFC 0046 step c1](../rfc/0046-desktop-app.md#as-built-step-c1-2026-11-13), `apps/desktop/stage.mjs`.

## macOS canonicalizes temporary executable paths

- **Symptom:** a relocated app runs correctly but a sandbox acceptance check reports `/private/tmp/...` instead of the expected `/tmp/...` executable.
- **Cause:** `/tmp` is a symlink on macOS; Node reports the canonical executable path.
- **Instead:** compare `realpathSync` of both executable paths. Keep the executable identity assertion, and always shut down the test's studiod before removing temporary directories, including after an assertion fails.
- **Found in:** [RFC 0046 step c1](../rfc/0046-desktop-app.md#as-built-step-c1-2026-11-13), `apps/desktop/e2e/packaged.e2e.ts`.

## Fake Agents still need separate data and project directories

- **Symptom:** a macOS browser acceptance fixture waits for a fake Agent's completion but receives only `sandbox_read_only`; the same fixture works on Windows.
- **Cause:** its project directory is nested inside its studiod data directory. The real macOS sandbox correctly refuses a writable workspace overlapping application data, even when the Agent process is fake.
- **Instead:** create sibling `data/` and `projects/` directories under the fixture's temporary root, and pass the same `data/` path to studiod, the Agent runtime and endpoint construction. Keep the sandbox restriction and completion assertion intact.
- **Found in:** [RFC 0046 step c1](../rfc/0046-desktop-app.md#as-built-step-c1-2026-11-13), `apps/web/e2e/previz-blockout.e2e.ts`.

## extraResources skips a root node_modules directory

- **Symptom:** signing a staged native executable fails with "No such file or directory" although it exists in the staging tree.
- **Cause:** electron-builder's generic file filter excludes a source root's `node_modules`, even for an `extraResources` mapping. A mapping of the parent resource directory silently omits all runtime packages.
- **Instead:** add a separate mapping from the staged `node_modules` directory to `resources/node_modules`, then verify the packaged app from a copied DMG. Native addons, the SDK executable and media binaries stay outside asar and receive the ad-hoc signature. Supply an empty entitlements plist with hardened runtime and automatic entitlement injection disabled for this preview stage; the builder otherwise injects its hardened-runtime defaults even when hardened runtime is false.
- **Found in:** [RFC 0046 step c1](../rfc/0046-desktop-app.md#as-built-step-c1-2026-11-13), `apps/desktop/electron-builder.config.mjs`.

## A staged app must also be the builder's project root

- **Symptom:** the shell asar unexpectedly contains workspace source, tests and zod, although its staged manifest declares no dependencies.
- **Cause:** when the staged dependency collection is empty, electron-builder falls back to its original project directory and collects that directory's production dependencies.
- **Instead:** use the staged app as `projectDir`, pass the Electron version explicitly, and fail packaging if the shell asar contains node_modules. Runtime modules are staged independently under extraResources.
- **Found in:** [RFC 0046 step c1](../rfc/0046-desktop-app.md#as-built-step-c1-2026-11-13), `apps/desktop/package.mjs`.

## LGPL ffmpeg needs encoder selection at every H.264 call site

- **Symptom:** timeline export works with an LGPL ffmpeg while a mock operation, trim/split or opaque render fails with "Unknown encoder 'libx264'".
- **Cause:** those paths embedded a GPL encoder name independently of timeline export's existing detection. Encoder-specific options such as CRF are not interchangeable with hardware or OpenH264 options.
- **Instead:** share the cached listing and one-frame trial from `detectVideoEncoder`, pass the selected executable path through, and use each profile's input, filter and output arguments. Mock placeholders prefer libx264, VideoToolbox, then OpenH264; cache this priority separately from hardware-first exports. Leave transparent VP9 encoding independent and retain faststart for opaque renders. Unit tests inject a listing containing only OpenH264 and check that each consumer uses its bitrate profile without CRF.
- **Found in:** [RFC 0046 step c1](../rfc/0046-desktop-app.md#as-built-step-c1-2026-11-13), `packages/generation/src/providers/lgpl-encoding.test.ts`.

## A macOS cross-build needs a target CPU in every build system

- **Symptom:** an Intel FFmpeg dependency is compiled with ARM feature probes, or a bundle works only in its build prefix.
- **Cause:** `-arch x86_64` controls Clang's output but does not change CMake's host processor. Shared libraries also retain their source-install IDs and rpaths, and editing those invalidates Mach-O signatures.
- **Instead:** set CMake's Darwin system, target processor and OSX architecture together; give Meson an explicit cross file and disable subproject downloads. Restrict pkg-config to the private source prefix, disable optional library autodetection, copy the complete dylib dependency closure (resolve libvpx's bare dylib ID only inside that prefix), rewrite IDs/dependencies/rpaths to `@loader_path`, then ad-hoc sign every modified Mach-O. Verify dependency paths, architecture, real caption/alpha pixels and hardware/software H.264 again from a relocated directory with `DYLD_*` cleared. FFmpeg reports the licence with `-L`, not `-version`.
- **Found in:** [RFC 0046 step c2](../rfc/0046-desktop-app.md#as-built-step-c2-2026-11-13), `scripts/build-ffmpeg-macos.mjs` and `scripts/ffmpeg/verify.mjs`.

## FFmpeg's disabled autodetection needs explicit system iconv linkage on macOS

- **Symptom:** compilation succeeds but linking `libavcodec` fails with undefined `_iconv`, `_iconv_open` and `_iconv_close`.
- **Cause:** with `--disable-autodetect`, FFmpeg's configure probes iconv in libc without adding macOS's separate system libiconv link flag; explicitly enabling iconv leaves its code compiled in.
- **Instead:** keep library autodetection disabled and add `--extra-libs=-liconv`, linking the SDK's system library. Check every resulting Mach-O with `otool -L` so a Homebrew iconv cannot enter the bundle.
- **Found in:** [RFC 0046 step c2](../rfc/0046-desktop-app.md#as-built-step-c2-2026-11-13), FFmpeg 9.0.2 configure and the arm64 source build.

## Media fixtures also select encoders through output extensions

- **Symptom:** MP3 probing tests fail on an LGPL bundle although it has a working MP3 decoder.
- **Cause:** the fixture writes `audio.mp3` without `-c:a`; FFmpeg selects the default MP3 encoder, which requires libmp3lame. A search for explicit encoder names does not find it.
- **Instead:** inspect fixture output formats as well as codec flags, and run the media suites with both binary overrides and the bundle directory first on `PATH`. Build LAME's shared library from source with its frontend and external decoder disabled. Keep the bundle LGPL; report fixtures that explicitly require libx264 rather than silently substituting another encoder in a wrapper.
- **Found in:** [RFC 0046 step c2](../rfc/0046-desktop-app.md#as-built-step-c2-2026-11-13), `packages/assets/src/media.test.ts`.

## Ephemeral localhost ports are shared with unrelated probes

- **Symptom:** provider tests passed alone but intermittently recorded an unauthenticated `GET /` or an empty request body during the full suite.
- **Cause:** desktop applications and browser extensions probe random localhost ports. Binding a fake HTTP server to `127.0.0.1:0` does not isolate its request log from those processes.
- **Instead:** use the shared [isolated HTTP fixture](../../scripts/testing/isolated-http.ts), which gives each server an unguessable base path and returns 404 outside it before recording or parsing. Give configurable adapters only that base URL; for fixed provider hosts, prepend it in the injected loopback transport. Strip the prefix before routing and TOS signature verification so original paths, signed hosts, authentication failures and unexpected adapter calls retain their assertions. Never filter recorded requests by authentication or expected routes to hide probe traffic.
- **Found in:** [fake-server isolation regression](../../scripts/testing/isolated-http.test.ts), 2026-11-11.

## A prepared worktree may predate the requested base

- **Symptom:** full browser tests repeatedly hit a scene number-field race that was already fixed on `main`.
- **Cause:** the named feature branch started before the required base revision and did not contain the fix. A matching branch name and a clean worktree do not establish ancestry.
- **Instead:** verify `git merge-base --is-ancestor <required-base> HEAD` before editing. If it fails, replay the feature commits onto the requested base before investigating failures in unrelated product areas, and rerun validation against that corrected tree.
- **Found in:** [RFC 0043 reference-label correction](../rfc/0043-video-references-and-media-hosting.md#reference-label-correction-2026-11-11); the missing scene regression was fixed in `5ae65a82`.

## Catalog-derived saves drop unrelated settings

- **Symptom:** saving provider settings would remove media hosting configuration.
- **Cause:** the UI rebuilds provider configuration from `providers.list`, which intentionally exposes hosting readiness without hosting details. A hosting field in `providers.json` would disappear on every such save and could also invalidate provider loading.
- **Instead:** keep hosting in its own validated `hosting.json`, reject it in provider updates, and treat a bad hosting file as unavailable without changing it or provider configuration.
- **Found in:** [RFC 0043 review](../rfc/0043-video-references-and-media-hosting.md#1-hosting-setting).

## `pnpm` is missing from `PATH` in non-interactive shells

- **Symptom:** `pnpm: command not found` from a background shell, an Agent's command runner or a hook, although `pnpm` works in your terminal.
- **Cause:** pnpm installed through a shell profile or a version manager is only on `PATH` after an interactive shell has loaded that profile.
- **Instead:** run `npx --yes pnpm@<version> <command>` with the version from `packageManager` in `package.json`; no global install is needed. Scripts and hooks should call `node` directly, as `scripts/hooks/` does.
- **Found in:** RFC 0041 step d, recorded in `CONTRIBUTING.md`.

## The local privacy check flags ordinary words and your public handle

- **Symptom:** `pnpm check:privacy` or the release dry run reports `[personal term] (home directory name)` on lines such as `customSizeHint`, or `(git user.name)` on `CODEOWNERS`, `LICENSE` and repository links.
- **Cause:** the local layer adds your git name, email and home directory name automatically and matches every term as a case-insensitive substring. A short directory name (three letters, say) turns up inside ordinary identifiers, and a git name that is your public GitHub handle belongs in the files that name the maintainer.
- **Instead:** add `!<term>` to `~/.config/vis-creative/private-words.txt` for each automatic term that is public or too short to be meaningful. List the values that really are private there instead (a work email domain, your full name), so the check gets stricter rather than quieter. Do not add `privacy-allow` markers for these: the hit is a property of your machine, not of the line.
- **Found in:** RFC 0042 step c, the first release dry run.

## TOS v4 resembles AWS signing but derives a different signing key

- **Symptom:** a request has plausible canonical headers but TOS refuses its signature.
- **Cause:** TOS derives `kDate` from the raw secret, without the AWS `AWS4` prefix. Presigned requests also use `UNSIGNED-PAYLOAD`, whereas header signing hashes the body. URI encoding must preserve object-key slashes and encode query slashes, spaces and reserved characters with uppercase percent escapes.
- **Instead:** verify both header and query signatures against the published TOS vectors before trusting a local fake, and make the fake independently verify every upload, read, list and delete. When routing signed test requests to loopback, preserve the original signed `Host` with `node:http`; modern `fetch` may replace it.
- **Found in:** [RFC 0043 §2](../rfc/0043-video-references-and-media-hosting.md#2-host-side-upload-service), [TOS header vector](https://docs.volcengine.com/docs/6349/74839), [query vector](https://docs.volcengine.com/docs/torch-object-storage/url-contains-a-signature).

## Upload deadlines must follow network inactivity rather than total elapsed time

- **Symptom:** a large reference on a slow connection failed at 60 seconds despite ongoing transfer, and buffering it doubled its memory cost.
- **Cause:** a total AbortSignal deadline and a copied file Buffer measured time rather than socket progress. A producer reading disk is also not evidence that the network is moving.
- **Instead:** hash a pinned file with one streaming pass, rewind it for a signed upload with Content-Length, and use socket inactivity plus the caller's cancellation signal. Exercise both slow informational-response progress and a peer that stops reading, with a shorter injected stall window.
- **Found in:** [RFC 0043 hosting review](../rfc/0043-video-references-and-media-hosting.md#2-host-side-upload-service), `tos-upload.ts`.

## Redaction must survive a restart and encoded vendor echoes

- **Symptom:** a vendor diagnostic retained a signed URL after the operation's in-memory URL list was gone, or when the URL was encoded twice.
- **Cause:** request-local secrets and raw query matching do not cover recovery reads or repeatedly encoded separators.
- **Instead:** load only the non-secret configured access key ID for synchronous redaction, scrub TOS URLs and signature/credential fields in raw, JSON-escaped and URI-encoded forms, and leave ordinary encoded result IDs unchanged. Also redact documented AKLT-shaped IDs independently of the current configuration so key rotation does not expose an earlier ID. Test the redactor on a fresh manager with no upload in flight.
- **Found in:** [RFC 0043 §2](../rfc/0043-video-references-and-media-hosting.md#2-host-side-upload-service), `hosting-redaction.ts`.

## A fallback hook must not run when the primary hook already answered

- **Symptom:** listing model limits failed through the legacy hook even though the adapter supplied valid model-specific limits.
- **Cause:** the legacy result was computed before the nullish fallback selected the newer declaration.
- **Instead:** call the legacy hook only when the primary declaration is absent, and test with a legacy hook that throws when it should not be consulted.
- **Found in:** [RFC 0043 §5](../rfc/0043-video-references-and-media-hosting.md#5-contract), `providers.ts`.

## Independent hosting stores need reconciliation after partial failure

- **Symptom:** a failed hosting save cleared a working secret, or a credential write succeeded while the UI and adapters still showed the old readiness.
- **Cause:** the file and credential store cannot commit atomically. Writing a new access key ID before deleting its old secret can mark mismatched credentials ready if deletion fails. A failed follow-up presence check also says nothing about whether the write succeeded.
- **Instead:** delete the secret before saving an access key change or replacing an orphan configuration; if deletion fails, keep the old file. Reread configuration and check credential presence once after each operation, even on failure. Preserve a successful operation's result when readiness becomes unknown. Refresh adapters and settings subscribers for every mutation outcome, without a revision counter; catch refresh failures with a generic log line that cannot replace the mutation result. A secret without a valid previous configuration has an unknown identity, so saving any new configuration clears it with a confirmation at save time.
- **Found in:** RFC 0043 hosting reviews rounds 2 and 3, `hosting.ts` and `gateway.ts`.

## Unknown readiness is different from a known missing credential

- **Symptom:** a credential store locked at startup left hosting unavailable until another settings write.
- **Cause:** caching a failed presence check as a successful absence check.
- **Instead:** keep failed checks unknown and retry from the next settings/catalog read at most once every 30 seconds until a check succeeds. Successful presence and absence checks stay cached until a hosting mutation: deleting a Keychain entry outside the app intentionally stays stale, and the next upload detects that deletion as `hosting.upload_failed`. Cache parsed hosting configuration too, invalidating inside mutations; studiod is the only writer, so hand edits require a restart.
- **Found in:** RFC 0043 hosting review round 2, `hosting.ts`.

## A streamed upload must own its cancellation and byte boundary

- **Symptom:** transport construction left an upload body and abort listener live, or a file appended after hashing sent bytes outside its signed length.
- **Cause:** cleanup registered only after creating the request, and an unbounded stream that read through the new end of the file.
- **Instead:** detach cancellation and destroy the body in `finally`, including constructor failures; bound both reads to the statted length. Do not destroy the successful hash read before rewinding its shared handle, because that closes the handle needed by the upload. Cache only the digest by path, size, modification time, inode and change time in a small bounded map, never the file contents. Size and modification time alone miss replacements and restored timestamps.
- **Found in:** RFC 0043 hosting review round 2, `tos-upload.ts`.

## Path expectations written with `/` fail on Windows

- **Symptom:** unit tests pass on macOS but fail on Windows with `C:\outside\draft.txt` received where `/outside/draft.txt` was expected, or a Seatbelt policy that does not contain `join(home, '.mavis')`.
- **Cause:** the code under test resolves paths with `node:path`, which uses the platform separator and adds a drive letter, and the Seatbelt policy writes each path through `JSON.stringify`, which doubles backslashes. A template such as `` `${dir}/draft.txt` `` or a raw POSIX literal only matches on POSIX.
- **Instead:** build expected paths the same way the code does: `join(dir, 'draft.txt')`, `resolve('/outside/draft.txt')`, and `` `(subpath ${JSON.stringify(path)})` `` for policy lines. Run `pnpm check` on Windows before calling a change cross-platform.
- **Found in:** MiniMax tests (`profile.test.ts`, `services/studiod/src/minimax.test.ts`), 2026-11-10.

## An esbuild external also excludes its subpaths

- **Symptom:** the `vis-scene.js` render bundle loaded in Chrome but failed on an unresolved `three/addons/loaders/GLTFLoader.js` import.
- **Cause:** `external: ['three']` in esbuild marks `three` and every `three/*` subpath as external, so the loader stayed a bare specifier that the import map does not resolve.
- **Instead:** externalize only the exact module (`/^three$/` through a plugin filter) so `three` comes from `/lib/three.module.js` and the loader is bundled.
- **Found in:** [RFC 0037 step c](../rfc/0037-interactive-scene-nodes.md#rendering), `build-render-scene.mjs`.

## `process.execPath` is not Node inside the desktop app

- **Symptom:** in an Electron build, children that studiod launches as "the current Node" (the `vis mcp` server, Windows `vis.cmd`, npm-installed Agent CLIs resolved from `.cmd` shims) open another app window or exit instead of running their script.
- **Cause:** under Electron, `process.execPath` is the app binary. It behaves as Node only when `ELECTRON_RUN_AS_NODE=1` is in that child's environment, and Agent environments are rebuilt from an allowlist, so the variable studiod itself was started with does not reach them.
- **Instead:** launch Node children through `process.execPath` and add `nodeChildEnv(command)` from `@vis/workbench-core` to that spawn's environment or MCP server config; `vis.cmd` sets it after `setlocal`. Do not add the variable to the Agent allowlist, where it would turn every Electron app the Agent starts into Node.
- **Found in:** [RFC 0046 step a](../rfc/0046-desktop-app.md#as-built-step-a-2026-11-11).

## On Windows, a child of the Electron main process keeps the app from exiting

- **Symptom:** the desktop app started studiod with `spawn(..., { detached: true, stdio: 'ignore' })` and `unref()`. After quit the window closed but the Electron main process stayed alive for as long as studiod did, and a parent reading the app's stdout or stderr (Playwright's `app.close()`, a terminal pipeline) never saw the pipes close.
- **Cause:** a process created directly by the Electron main process after `ready` inherits handles of that process, including its output pipes, whatever `stdio` and `detached` say. The same spawn before `ready`, or from plain Node, does not behave this way.
- **Instead:** on Windows start a process that must outlive the app through the shell: PowerShell `Start-Process` with the script on stdin and the paths passed as base64 (`windowsStartScript` in `apps/desktop/src/studiod-process.ts`). The process then has no output handles from the app, so it writes its own log (`VIS_STUDIOD_LOG`), and the launcher's exit code says only whether the launch worked. POSIX keeps the direct detached spawn.
- **Found in:** [RFC 0046 step b](../rfc/0046-desktop-app.md#as-built-step-b-2026-11-12), `apps/desktop/e2e/smoke.e2e.ts`.
