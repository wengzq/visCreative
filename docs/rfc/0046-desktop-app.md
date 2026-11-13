# RFC 0046: Desktop app

Status: accepted (maintainer, 2026-11-11), with the decisions at the end; step a implemented 2026-11-11, step b (the shell, run from source) 2026-11-12, step c1 (arm64 DMG packaging) and step c2 (macOS LGPL ffmpeg build) 2026-11-13. The update host is GitHub Releases on the public repository (decision 6, 2026-11-13). Scope set by the maintainer on 2026-11-11: macOS and Windows, signed, with auto-update, reached in two stages: an unsigned preview first, then signed releases once the accounts exist.

Builds on [RFC 0004](0004-runtime-and-agent-entry.md) (studiod as its own process), [RFC 0006](0006-web-ui.md) (the web host stands in for the desktop main process), [RFC 0022](0022-windows.md) and [RFC 0024 §8](0024-timeline-editing.md) (packaging requirements for media).

## Background

Today the app runs as two Node processes started from a terminal: `pnpm dev:studiod` and the web host, opened in a browser tab. Authors must install Node, pnpm, Visual Studio Build Tools on Windows (better-sqlite3 has no Windows prebuilt for 13.x), ffmpeg 7+ and Chrome before they can start. A desktop app removes the toolchain: download, open, sign in to an Agent CLI, work.

`apps/desktop` exists as an empty package. Earlier RFCs assumed Electron, but the maintainer asked for the choice to be argued here before adding the dependency.

### How the app runs today (surveyed 2026-11-11)

- **studiod** is an esbuild bundle (`services/studiod/dist/studiod.mjs`) that still needs `node_modules` at runtime for `better-sqlite3` (native), `@anthropic-ai/claude-agent-sdk` (per-platform native `claude` binaries) and `playwright-core`, plus sidecar files: `dist/lib/*` render libraries, `migrations/`, fixtures and the `vis` CLI directory (`VIS_CLI_BIN_DIR`). It listens on a Unix socket or a Windows named pipe derived from the data directory, holds a single-instance lock in `<dataDir>/run`, writes `run/studiod.token` (0600), and exits after 10 idle minutes.
- **The web host** (`apps/web/src/host/server.ts`) serves the UI on 127.0.0.1 with a per-start token, checks Host and Origin on its WebSocket, forwards JSON-RPC lines to studiod, and serves asset, upload, export and poster routes. UI packages receive these as an injected `RpcClient` and host-supplied URLs.
- **There is no production data directory default.** `main.ts` requires `VIS_DATA_DIR`; only `~/.vis-dev` appears in code.
- **ffmpeg** is found on `PATH`. `ffmpegPath` / `ffprobePath` options exist in `@vis/assets` and the render provider, but `services/studiod/src/main.ts` never sets them.
- **Rendering** (`render/html`, `render/scene`) launches a system Chrome or Edge through `playwright-core`, located by `VIS_CHROME_PATH` or well-known install paths.
- **Agent CLIs** (Codex, dsh, CodeBuddy, MiniMax Code) are found on `PATH` or by `VIS_*_PATH`; Claude runs through the bundled agent SDK. `vis.cmd` and the MCP server entry spawn `process.execPath`. On macOS, Agents run under `sandbox-exec`.
- **Credentials** go through `/usr/bin/security` and PowerShell `PasswordVault`; neither depends on a terminal.

## Goals

- One installer per platform: macOS (Apple silicon and Intel) and Windows x64. No Node, pnpm, compiler or ffmpeg install needed.
- Builds that update themselves, without interrupting running turns or generation jobs beyond what RFC 0004's version handshake already allows. An unsigned preview comes first; signed and notarized releases follow (see Release stages).
- The same UI packages as the web host, unchanged. `apps/web` stays for development and e2e.
- The product rules hold unchanged: credentials only in the system store, permissions in the gateway, Windows isolation disclosure (RFC 0022).

## Out of scope

- Mac App Store and Microsoft Store. App Sandbox forbids spawning user-installed Agent CLIs.
- Linux packages, Windows arm64, launch at login, a tray icon, deep links. Later steps if wanted.
- Bundling Agent CLIs. Authors install and sign in to their Agents as today; the app shows each registry entry's install hint.
- Changing studiod's protocol or the UI packages beyond host wiring.

## Shell choice: Electron or Tauri

| Concern | Electron | Tauri 2 |
| --- | --- | --- |
| Rendering engine | Chromium everywhere, the same engine our e2e suite drives | WebKit on macOS, WebView2 (Chromium) on Windows: two engines to support |
| Transparent video preview (RFC 0036) | VP9-alpha WebM plays, as tested today | WebKit's transparent video path is HEVC with alpha, not VP9-alpha WebM (to confirm on current macOS); the macOS preview and timeline overlay likely need another format |
| Canvas, timeline playback, WebGL scenes (RFC 0024, 0037) | Measured in Chrome already | Unmeasured in WKWebView; RFC 0024 performance numbers would need a second baseline |
| Running studiod | Electron's own Node via `ELECTRON_RUN_AS_NODE=1`; better-sqlite3 rebuilt once for Electron's ABI | Must ship a separate Node runtime as a sidecar (~40–60 MB), plus its own better-sqlite3 build |
| `process.execPath` for `vis.cmd` and MCP | Works with `ELECTRON_RUN_AS_NODE=1` in the child environment | Works if spawned from the sidecar Node |
| Main-process language | TypeScript, shares code with `apps/web/src/host` | Rust: a new toolchain and language in the repo |
| Updates | `electron-updater` (GitHub Releases, generic HTTPS feed), signature-checked on Windows | Tauri updater (own signing key plus OS signing) |
| Installer size, rough | ~110 MB shell + ffmpeg ~70 MB + app ≈ 200 MB | ~10 MB shell + Node ~50 MB + ffmpeg ~70 MB + app ≈ 140 MB |
| Memory | One more Chromium process tree | Lighter shell, same studiod and Chrome render cost |
| Rendering jobs (system Chrome) | Unchanged, see below | Unchanged, see below |

The main advantage of Tauri, size, shrinks because studiod needs Node either way: the saving is about 60 MB of a ~200 MB download. Against it, Tauri on macOS changes the engine under every UI feature we have tested, breaks the transparent preview path, and adds Rust. **Recommendation: Electron**, with `electron-builder` for packaging (DMG and NSIS, `asar` with native files unpacked) and `electron-updater` for updates. Both are new dependencies and need the maintainer's approval.

## Design

### Processes

```
Electron main ── starts/attaches ──▶ studiod (ELECTRON_RUN_AS_NODE=1, detached, own log file)
     │                                    ▲
     ├── in-process web host ─────────────┘  (named pipe / Unix socket, ui token)
     └── BrowserWindow ── http://127.0.0.1:<port>/#t=<token>
```

- studiod stays a separate, detached process (RFC 0004), so an app update or a closed window does not stop running turns. Its idle exit still applies.
- **The renderer loads the existing web host, run inside the main process**, instead of a new IPC transport. The host already does token, Host and Origin checks and serves every asset, upload, export and poster route the UI needs, so UI packages and their URL contracts do not change and e2e keeps covering the same code. This revises RFC 0004's "renderer goes through the main process": it still does, over loopback HTTP and WebSocket rather than Electron IPC. A custom `vis://` protocol with IPC remains possible later if loopback causes trouble.
- The window gets `contextIsolation`, `sandbox`, no Node integration and a navigation lock to the host origin. Links to other origins open in the system browser. Agent-produced HTML is still never executed in the renderer (AGENTS.md).
- Native dialogs replace the `osascript` and WinForms folder pickers when running in the app, through a small preload API (`pickDirectory`). The web host keeps its current pickers.
- One app instance per user (`requestSingleInstanceLock`); a second launch focuses the window. studiod's own lock is unchanged.

### Runtime prerequisites in studiod (shell-independent, step a)

- **Data directory default:** `~/Library/Application Support/visCreative` on macOS and `%APPDATA%\visCreative` on Windows when the app starts studiod; `VIS_DATA_DIR` still overrides, and development keeps `~/.vis-dev`. Project folders default outside it (see known issue on project roots containing app data).
- **Media binaries:** `VIS_FFMPEG_PATH` / `VIS_FFPROBE_PATH` read in `main.ts` and passed to `createFfmpegMedia` and the render provider; encoder checks already cache per path.
- **Fonts:** the app sets `VIS_FONTS_DIR` to its packaged copy.
- **Child Node:** when studiod runs under Electron, every spawn of `process.execPath` (the `vis.cmd` shim, the MCP server entry) sets `ELECTRON_RUN_AS_NODE=1` in that child's environment. Agents never see the app's environment beyond the existing allowlist.
- **PATH for GUI launches:** macOS apps started from Finder get a minimal `PATH`, so Agent CLIs installed by npm, Homebrew or nvm are not found. At startup the main process reads `PATH` only from the user's login shell (`$SHELL -ilc` printing `PATH`, with a timeout) and passes it to studiod. No other shell variables are imported; Agent environments keep their allowlist. Windows GUI apps already inherit the user `PATH`.

### Packaged contents

- studiod, web host, `vis` CLI bundles; `node_modules` limited to `better-sqlite3` (Electron ABI), `@anthropic-ai/claude-agent-sdk` with the target platform's native binary, and `playwright-core`; render libraries, migrations, fonts and their licences.
- **LGPL ffmpeg/ffprobe** per platform and architecture (RFC 0024 §8): dynamically linked, no GPL or nonfree flags, with libass, freetype and harfbuzz for captions, licence text and a source offer. H.264 export uses hardware encoders (VideoToolbox, `h264_mf`, NVENC) with `libopenh264` as fallback; RFC 0024's Windows LGPL validation runs here.
- Native files (`.node`, the `claude` binary, ffmpeg) live outside `asar` and are signed individually.

### Rendering jobs and Chrome

Render jobs keep using a system Chrome or Edge through `playwright-core`. Windows always has Edge; a Mac without Chrome cannot run render jobs and already gets a localized "install Google Chrome" error. Options are listed under Decisions; the default proposal is to keep system browsers and improve the error with a link to the download page.

### Signing, notarization and updates (step d2 unless noted)

- **macOS:** Developer ID Application certificate, hardened runtime with `allow-jit` and `allow-unsigned-executable-memory` (V8), notarized and stapled. Agents still run under `sandbox-exec`, which needs a validation pass from a hardened-runtime parent. Keychain access stays through `/usr/bin/security`, so existing items keep their access lists.
- **Windows:** Authenticode signing of the installer and every shipped executable (Electron, ffmpeg, the `claude` binary). An OV certificate or Azure Artifact Signing (formerly Trusted Signing); SmartScreen reputation builds over time either way.
- **Updates:** `electron-updater` checks a release feed at startup and every few hours, downloads in the background and asks before restarting. On restart the new main process follows RFC 0004's handshake: reuse the running studiod if its protocol is compatible, otherwise tell the author what is running, call `runtime.shutdown` once turns can be interrupted, and start the new studiod; interrupted turns and jobs recover as today. An update never cancels generation (cost rule).
- **Channels:** stable only at first; a beta channel later if needed.
- **Release pipeline:** builds run on macOS and Windows machines with the signing material. Archive CI is off for cost (2026-11-09), so the first releases are built locally by the maintainer with a scripted, checked release command, as RFC 0042 does for the public snapshot. Signing secrets live in the system credential store of the build machine, never in the repository or CI logs.

### Release stages

Signing needs paid accounts and identity checks that take weeks, while steps a–c need none. The release is split so testers get builds as soon as packaging works.

**d1. Unsigned preview.** No Apple Developer ID and no Windows certificate.

- **macOS:** builds are ad-hoc signed by `electron-builder` (required to run on Apple silicon) and not notarized. Gatekeeper blocks the first launch; since macOS 15 the author allows it in System Settings › Privacy & Security › Open Anyway. The updater cannot install unsigned updates on macOS (Squirrel.Mac requires a stable signing identity), so the app checks the feed and shows "version X is available" with a link to the download; the author replaces the app by hand. Folder-access permissions may be asked again after each update because they follow the code signature. Keychain items are unaffected: access goes through `/usr/bin/security`, not the app's identity.
- **Windows:** the NSIS installer is unsigned. SmartScreen warns (More info › Run anyway), and Smart App Control, where enabled, blocks the install with no bypass; the README says so. `electron-updater` installs updates, checking each installer's SHA-512 from the feed; there is no publisher check without a certificate.
- **Trust:** without signatures the release host is the only protection for updates: anyone who can write to it can ship code to every user. The upload credential lives only in the build machine's system credential store, the feed is HTTPS only, and the preview is offered to known testers, not announced publicly.
- **Labelling:** the window title, About box and README call it a preview build and link to install instructions for both platforms.

**d2. Signed release.** Starts when the prerequisites below exist. Adds Developer ID signing with hardened runtime and notarization, Authenticode signing, the Windows publisher check in the updater (`publisherName`), and in-place updates on macOS. The d1 code stays; d2 turns on signing configuration and switches the macOS update path from notice to install. An app moving from d1 to d2 on macOS needs one manual download, because the old ad-hoc build cannot verify the signed update.

### Testing

- e2e keeps running against `apps/web` with Chrome; the UI code is identical.
- New desktop smoke tests with Playwright's Electron support (step b has the from-source version): launch the packaged app against an isolated data directory, attach to studiod, open a project, run a mock generation and a local render, quit and relaunch to confirm studiod reuse.
- Update tests against a local feed with two fake versions, compatible and incompatible protocol.
- Manual acceptance on a clean macOS and Windows machine with no Node, compilers or ffmpeg installed: install, first launch, Agent discovery from a GUI launch, Keychain and PasswordVault, export with the LGPL ffmpeg, update.
- A visual pass over the packaged app on both platforms (maintainer, 2026-11-12): screenshots of the main views checked by eye, including the top bar and how it sits under the native title bar.

## As built: step a (2026-11-11)

Shell-independent pieces, testable with plain Node; nothing starts Electron yet.

- **Data directory:** `runtime/app-paths.ts` `defaultDataDir()` returns `~/Library/Application Support/visCreative`, `%APPDATA%\visCreative`, or `$XDG_DATA_HOME/visCreative` elsewhere. studiod still requires `VIS_DATA_DIR`; the shell will pass this value in step b.
- **Login-shell PATH:** `runtime/login-shell-path.ts` `readLoginShellPath()` runs the user's absolute `$SHELL` with `-ilc`, prints `PATH` between markers so start-up banners are ignored, and gives up after 5 seconds or on any failure. `mergePath()` puts login entries first and keeps the app's own. Windows returns nothing. Only `PATH` is read.
- **Media binaries:** `VIS_FFMPEG_PATH` and `VIS_FFPROBE_PATH` (ffprobe defaults to the same directory as ffmpeg) feed studiod's `media` tools, which already carry the paths to previews, timeline export and encoder detection, and the render and mock providers. Unset, everything still uses `PATH`.
- **Fonts:** `VIS_FONTS_DIR` already existed (RFC 0024); `main.ts` now documents it with the other variables.
- **Node children:** `nodeChildEnv(command)` adds `ELECTRON_RUN_AS_NODE=1` only when running inside Electron and the command is `process.execPath`. It is applied to the Codex app server and ACP Agent spawns (Windows npm shims resolve to `process.execPath`), to the `vis mcp` server config for Codex and ACP Agents, and to the render-library build. `vis.cmd` sets it after `setlocal`. It is never added to the Agent environment allowlist. See [docs/lessons/tooling.md](../lessons/tooling.md).

Found for later steps:

- **Mock video operations need `libx264`.** The mock provider encodes its placeholder clips with `libx264`, which an LGPL ffmpeg lacks. Step c either hides the mock provider in packaged builds or switches it to an encoder the bundled build has.
- **On macOS, the sandbox profile must let Agents start the app binary.** The `vis mcp` server runs through the Electron binary inside `sandbox-exec`, so step b must check the profile allows executing it from the app bundle.
- **npm-installed Agent CLIs on macOS still need a system Node.** On POSIX their `#!/usr/bin/env node` shebang finds Node through `PATH`, which the login-shell PATH supplies; authors who installed them through npm have Node already.

## As built: step b (2026-11-12)

The shell in `apps/desktop`, run from source with `pnpm dev:desktop`. Nothing is packaged yet; the packaged layout below is computed and unit-tested but not exercised until step c.

- **Layout** (`layout.ts`): from source the app uses the repository builds and `~/.vis-dev`; packaged it uses `defaultDataDir()` and `resources/{studiod,cli,web,ffmpeg,fonts}`. `VIS_DATA_DIR` overrides the data directory in both.
- **Which Node runs studiod:** Electron 45 embeds Node with a different native-module ABI from the system Node the repository builds against, so the repository's better-sqlite3 does not load under it. From source studiod therefore runs on the system Node (`VIS_DESKTOP_NODE`, else the Node that runs pnpm, else `node` on `PATH`). Packaged, it runs through the app binary with `ELECTRON_RUN_AS_NODE=1`, which needs the Electron build of better-sqlite3 from step c. studiod removes the variable from its own environment at start, so only the children `nodeChildEnv` names receive it.
- **Start or attach** (`studiod-process.ts`): the app probes the endpoint, starts studiod when nothing answers, and polls for up to 30 seconds. A launcher that exits with 0 lost the start race and is not a failure. studiod is started detached and survives quit; while a window is open the app holds one connection and starts studiod again if it goes away. A running studiod with another protocol version produces a dialog and the app quits; handover is step d1.
- **Windows launch:** a child created directly by the Electron main process inherits its handles, and the app then cannot exit while studiod lives. On Windows studiod is started through PowerShell `Start-Process`, with the script on stdin and paths as base64. See [docs/lessons/tooling.md](../lessons/tooling.md).
- **Log:** because no output handles reach studiod, it writes its own log when `VIS_STUDIOD_LOG` is set: `<dataDir>/logs/studiod.log`, console output with a timestamp and level, plus uncaught errors. The app moves a log above 5 MiB to `studiod.log.1` before a start. The rule that secrets never reach a log is unchanged.
- **Host and origin:** the web host runs in the main process on loopback. Preferences live in `localStorage`, which is bound to the origin, so the port is remembered in `<dataDir>/shell/host-port` and requested again; when it is taken the app uses a random port for that run and keeps the remembered one. Electron's own profile (`userData`) is `<dataDir>/shell`, so an isolated data directory isolates the whole app.
- **Window policy** (`navigation.ts`, `main.ts`): context isolation, sandbox, no Node integration, no `<webview>`. Only the host origin loads in the app; other `http(s)` links open in the system browser; every other scheme is dropped. Permission requests are denied except sanitized clipboard writes and fullscreen from the host origin.
- **Folder picker:** the preload exposes one function, `visDesktop.pickDirectory`, backed by the native dialog and checked against the sender's origin. `apps/web/src/client/desktop-bridge.ts` uses it in the app and the `fs.pickDirectory` RPC in a browser.
- **Single instance:** a second launch focuses the existing window and exits.
- **Copy:** the few native strings (start failures, dialog title) are in `apps/desktop/src/messages.ts` in both languages, chosen from the system locale.
- **Tests:** unit tests in `apps/desktop/src/desktop.test.ts` (part of `pnpm check`). The smoke test `pnpm --filter @vis/desktop test:smoke` (after `pnpm build` and `pnpm --filter @vis/desktop build`) drives the real app with Playwright against an isolated data directory: UI on screen, no Node in the page, folder picker, external links, second launch, quit with studiod surviving, relaunch with the same token, origin and `localStorage`. It is not part of `pnpm check` or the web e2e suite, and it uses the source layout, not a packaged app; mock generation and local render through the app are left to the packaged smoke test in step c.

Not verified, carried to step c acceptance:

- **macOS.** Step b was built and run on Windows only. The direct detached launch, the login-shell `PATH` at start-up, and dock behaviour (`activate`, staying open with no window) are untested on macOS.
- **Sandbox profile and the app binary.** The Agent sandbox profile is allow-by-default with deny rules for secrets and data, so executing the app binary from the bundle should be allowed; this is by reading `sandbox.ts`, not by running it.

Found for step c:

- **Packaging output must be relocatable.** Packaging writes several gigabytes (unpacked apps, installers, the Electron and ffmpeg downloads). The output directory and the download caches are set through environment variables, with a default inside the repository's ignored `artifacts/`, so a machine with a small system drive can build on another one. No machine path is committed.

## As built: step c1 (2026-11-13)

`pnpm --filter @vis/desktop dist:mac` builds the repository and Electron shell, fetches/verifies the caption fonts and their licences, stages resources, rebuilds SQLite against Electron 45's headers, and invokes electron-builder for an arm64 DMG. `dist:mac --x64` selects the separate Intel target in the configuration; only arm64 is verified. Electron is in pnpm's `onlyBuiltDependencies`; Electron 45 also installs a missing development binary on first use.

- **Relocatable build:** `VIS_DESKTOP_OUTPUT_DIR` defaults to the ignored `artifacts/desktop/`; staging is under `stage/`, installers and unpacked apps under `dist/`, and caches under `cache/`. `electron_config_cache` overrides Electron's download cache (also passed explicitly to the builder); `ELECTRON_BUILDER_CACHE` overrides the builder's download cache. SQLite headers use `cache/headers/`. No machine path is committed.
- **Resource layout:** `resources/studiod/{dist,migrations}` includes every sidecar from `copy-studiod-assets.mjs` (mock video fixture, render libraries and scene bundle); `resources/web/client` holds the UI; `resources/cli` contains `vis.mjs` and an executable POSIX `vis` launcher. The launcher resolves the app binary relative to itself and sets `ELECTRON_RUN_AS_NODE=1` only for that child, so spaces, moving the app and Agent PATH injection work. `vis mcp` still uses studiod's `process.execPath` plus `nodeChildEnv`, as in step a. `resources/fonts` contains font files and licences directly, matching `VIS_FONTS_DIR`.
- **Runtime packages:** only better-sqlite3, the Claude agent SDK (with its darwin-arm64 native package nested inside it), and playwright-core are staged in `resources/node_modules`. SQLite is copied and rebuilt separately, with all original prebuilds, build dependencies and intermediate objects removed; the repository's Node dependency is untouched. The SDK's other platform binaries are omitted. Runtime packages and native files are outside asar; only the bundled shell and its manifest are inside. The explicit node_modules resource mapping avoids electron-builder's root-directory exclusion.
- **ffmpeg interface:** when `VIS_PACKAGE_FFMPEG_DIR` is set, its runtime binaries, adjacent dylibs, licences and `BUILDINFO.json` are copied flat into `resources/ffmpeg`, with its architecture checked against the staging target. `source/` stays in c2's build output for separate hosting and is excluded from the app; a post-pack guard rejects any reintroduced source directory. Without the ffmpeg directory the package command prints a warning and the app uses PATH. The in-house LGPL build is step c2 and has no dependency on this staging implementation.
- **Agent media PATH (maintainer, 2026-11-13):** studiod derives the configured ffmpeg directory once beside `prepareAgentCli` and passes it to Codex, Claude and every ACP adapter, including DeepSeek. The shared `agentPath` helper puts the vis launcher first, preserves user login-shell entries, then appends configured fallback directories without duplicates. No ffmpeg directory is added when `VIS_FFMPEG_PATH` is unset. Agents can therefore run bundled ffmpeg/ffprobe from their shell while a user-installed ffmpeg still wins. The c2 LGPL build has no libx264; Agents should select `h264_videotoolbox` or `libopenh264`. No Electron environment variable is added to the allowlist. The existing macOS policy permits executable and dylib reads in the app bundle through its default allowance; no sandbox permission was broadened. Strict packaged acceptance resolves both tools through an Agent-equivalent sandboxed shell on a system-only PATH, checks the bundled version, encodes lavfi H.264 and probes the result.
- **LGPL encoding:** mock video operations, trim/split and opaque HTML/scene renders share `SOFTWARE_FIRST_H264_ENCODERS` from assets: libx264, VideoToolbox, OpenH264. Timeline export keeps its hardware-first order. Consumers use each encoder's input, filter and quality options; opaque x264 rendering keeps CRF 18 and faststart, and transparent VP9 is unchanged. Successful detection and concurrent probes are cached per path and order; a rejected probe is evicted so installing ffmpeg or recovering from a timeout takes effect without a restart. Tests cover retry after rejection, shared preference over listed hardware, OpenH264-only consumers, and render quality without mutating the cached profile. The c2 VideoToolbox build with `-allow_sw 0` encoded both 64×64 and 128×128 clips on this Mac, and the packaged smoke now renders at the 64-pixel minimum.
- **Preview signing:** `identity: '-'`, `hardenedRuntime: false`, `notarize: false`, an empty entitlements plist and disabled automatic entitlement injection produce ad-hoc signatures without hardened-runtime entitlements. Native sidecars are explicitly included in signing. No Developer ID, notarization, updater or release feed is configured.
- **Icons:** `apps/web/src/client/public/favicon.svg` is the single artwork source. Each package run rasterizes that SVG unchanged through an isolated, offscreen Electron window, without new dependencies or committed generated bitmaps. macOS uses an 824-pixel body centered on a transparent 1024-pixel canvas (the SVG's own corner radius scales with it); `iconutil` generates the icns sizes. The app and DMG volume use that icns, while `win.icon` uses a full-size 256-pixel rendering of the same SVG; NSIS inherits the converted Windows icon. Generated icons live under the relocatable output directory's `icons/`.
- **Packaged acceptance:** `VIS_PACKAGED_APP="<copied app>/visCreative.app" pnpm --filter @vis/desktop test:packaged` launches a built or relocated app with temporary data and project directories. It checks the first project on screen, a mock image, mock video and an actually encoded mock operation when H.264 is usable, a local Chrome render (or a clear missing-Chrome skip), the CLI launcher, fonts, studiod's executable via `lsof`, token-free logs, Agent environment filtering and executing the app binary through the real macOS sandbox profile. It closes the window, checks Dock presence, emits `activate`, quits/relaunches and checks the same studiod PID and token. Cleanup calls `runtime.shutdown` and waits for process exit before removing data. `VIS_PACKAGED_REPORT` optionally writes its evidence JSON. This and `test:smoke` are independent gates outside `pnpm check` and web e2e; their TypeScript is checked by the desktop package.
- **Verified on Apple silicon:** `pnpm check` passed (4,116 tests passed, 19 skipped); after the repository build the complete web e2e passed twice consecutively (392 tests in 54 files each). The source smoke and a mounted-DMG copy launched from a path containing spaces both passed. Packaged acceptance skipped nothing: PATH ffmpeg supplied H.264 and Chrome was installed. The relocated-output DMG measured 270,252,741 bytes and its app files 615,034,806 bytes. `codesign --verify --deep --strict` passed, `codesign -dv` reported `Signature=adhoc`, the entitlements dictionary was empty, and every shipped `.node` and the SDK executable was arm64. Sandbox execution reported Electron 45.3.0, Node 24.22.2 and ABI 150.
- **c2 integration:** the initial integration DMG included the LGPL ffmpeg 9.0.2 arm64 bundle, adjacent dylibs, licences and source archives through `VIS_PACKAGE_FFMPEG_DIR`. Its mounted-and-copied app passed the packaged gate with `VIS_PACKAGED_REQUIRE_BUNDLED_MEDIA=1`, a system-only PATH and `SHELL=/usr/bin/false` (preventing login-shell PATH import); system ffmpeg was unavailable, the bundle listed no libx264, mock video and local render selected `h264_videotoolbox`, and nothing was skipped. That icon-bearing DMG measured 400,064,487 bytes before the separate-hosting decision below. All 134 render-provider, scene-render and generation tests passed with `VIS_FFMPEG_PATH` set and the same bundle prepended to PATH for direct fixture calls. The sole initial failure was the alpha-composition fixture's direct libx264 requirement: its flat-colour input now uses MPEG-4 and composition uses the detected encoder, with pixel and alpha assertions unchanged. The packaged icns was extracted at 1024 and 128 pixels for inspection, matched the generated file, and the DMG volume icon matched it too; deep/strict signature verification passed after packaging the native media files.
- **Packaging review corrections:** the POSIX launcher resolves absolute and relative symlink chains before finding the app, including a `vis` symlink installed in a separate bin directory. The build invokes JavaScript package-manager entries through Node and native standalone entries directly. Staging records its platform, architecture and Electron version in `target.json`; the builder derives its single architecture from that record and rejects mismatched CLI targets before packing. Intel remains a separate `dist:mac --x64` build, never a second target over arm64 native files. Packaged acceptance selects the daemon from all lock-file PIDs by its executable and entry, tests the real launcher through a symlink, and bounds graceful shutdown; on failure it verifies the process still owns that isolated lock before SIGTERM/SIGKILL, then removes data only after exit. Unit tests cover these paths and preserve data if a process cannot be stopped.
- **Licence compliance and separate sources (maintainer, 2026-11-13):** exact source archives are hosted separately instead of shipped in the app. Staging generates `resources/ffmpeg/SOURCE-OFFER.txt` from `BUILDINFO.json`, listing every component, version, licence, archive filename and SHA-256, and stating that the source download includes the exact build recipes. `VIS_FFMPEG_SOURCE_URL` supplies the download location. Until the source host is chosen (Decision 6), local preview builds without that variable use "available on request" wording and print a warning. **The d1 release script must require the hosted source URL and include the exact build recipes in that download before distribution.** c2's `source/` output is unchanged and remains available for upload; licences and build metadata stay in the app. Strict packaged acceptance checks the offer and rejects a packaged `source/` directory.
- **Separate-source verification:** the rebuilt local-preview DMG measured 284,076,402 bytes and its app file contents 645,132,411 bytes. The mounted-and-copied app passed the strict LGPL smoke with no skips, the offer identified all ten exact archives, and their original c2 SHA-256 values were unchanged. Runtime contents are the two executables, sixteen adjacent dylibs, `LICENSES/`, `BUILDINFO.json` and `SOURCE-OFFER.txt`; no `source/` directory is packaged.

- **Final combined verification (review, source offer and Agent PATH):** `pnpm check` passed with 4,141 tests and 19 skips; after the build the full web e2e passed twice consecutively (392 tests in 54 files each). Source smoke and the mounted-DMG copy smoke passed, with no packaged skips. The sandboxed Agent shell encoded H.264 with bundled VideoToolbox, as did mock video and the local render; all 134 targeted render/scene/generation tests also passed against the c2 bundle. The final DMG measured 284,076,230 bytes and app file contents 645,133,769 bytes. Deep/strict ad-hoc signature verification passed and all twenty native files were arm64.

Not verified in c1: Intel and Windows packages, clean-machine installation, Gatekeeper/quarantine acceptance, real Agents or provider keys, and the full visual pass on macOS and Windows. The Dock lifecycle and sandbox execution checks above are automated on Apple silicon; clicking the physical Dock icon and Finder-specific PATH discovery still need a manual acceptance pass. The c2 arm64 bundle and source offer are integrated and tested; d1/d2 remain unchanged.

## As built: step c2 (2026-11-13)

The macOS media bundle is built from pinned source archives by `scripts/build-ffmpeg-macos.mjs`; set `VIS_PACKAGE_FFMPEG_DIR` to `<out>/darwin-<arch>` so desktop packaging copies its directory flat into `resources/ffmpeg/`. No binaries or archives are committed.

1. **Build and tools.** Run `pnpm build:ffmpeg:mac --arch arm64` on macOS with Xcode Command Line Tools and `brew install pkg-config nasm meson ninja cmake`. Homebrew supplies build tools only. `--arch x64` cross-compiles every dependency and FFmpeg for Intel on Apple silicon, without executing target build tools. Both targets require macOS 13 or newer. `VIS_FFMPEG_JOBS` defaults to at most four compiler jobs. `VIS_FFMPEG_OUT_DIR` defaults to `artifacts/ffmpeg/out`, `VIS_FFMPEG_CACHE_DIR` to `artifacts/ffmpeg/cache`; put the cache at a path without spaces. Every rerun rehashes existing downloads and reuses only verified archives. It rebuilds in a clean architecture-specific work directory and replaces the previous output only after successful staging.

2. **Dependencies and licences.** Every archive URL, version, SHA-256 and licence-file path is pinned in [`scripts/ffmpeg/sources.json`](../../scripts/ffmpeg/sources.json). The bundled versions are:

   | Source | Version | Selected licence |
   | --- | --- | --- |
   | FFmpeg | 9.0.2 | LGPL 2.1 or later |
   | FreeType | 2.14.3 | FreeType License (FTL) |
   | HarfBuzz | 15.1.0 | MIT |
   | FriBidi | 1.0.18 | LGPL 2.1 or later |
   | libass | 0.17.5 | ISC |
   | OpenH264 | 2.7.0 | BSD 2-Clause |
   | libvpx | 1.17.0 | BSD 3-Clause, with PATENTS notice |
   | Opus | 1.6.1 | BSD 3-Clause |
   | dav1d | 1.5.4 | BSD 2-Clause |
   | LAME | 4.0 | LGPL 2.0 or later (library only) |

   No dependency requires LGPL version 3. Libraries are shared. FreeType's optional compression/image libraries and HarfBuzz integration are disabled to avoid a dependency cycle; HarfBuzz uses this FreeType. libass uses CoreText for font lookup, with fontconfig and optional external libraries disabled. Opus neural extensions, LAME's frontend/decoder/legacy assembler, dependency test programs and utilities are disabled. LAME uses C17 and the documented upstream legacy-ID3 declaration workaround. `pkg-config` searches only the source-build prefix, Meson cannot download subprojects, FFmpeg autodetection is disabled, and compiler/search-path environment overrides are cleared. System frameworks and SDK libraries remain system dependencies.

3. **FFmpeg configuration.** Architecture, SDK, deployment target, compiler flags and the private build prefix are set explicitly. The common flags are:

   ```text
   --enable-shared --disable-static --disable-autodetect
   --disable-gpl --disable-version3 --disable-nonfree
   --disable-debug --disable-doc --disable-ffplay --disable-network
   --enable-videotoolbox --enable-audiotoolbox --enable-zlib --enable-iconv
   --extra-libs=-liconv
   --enable-libass --enable-libfreetype --enable-libharfbuzz --enable-libfribidi
   --enable-libopenh264 --enable-libvpx --enable-libopus --enable-libdav1d --enable-libmp3lame
   ```

   Built-in LGPL codecs, formats and filters stay enabled for imported media. H.264 delivery uses `h264_videotoolbox` with software fallback disabled in the hardware trial, then `libopenh264` with bitrate options. `libx264` is deliberately absent. The previously hard-coded `libx264` calls in mock generation, opaque HTML/scene rendering and local video trim/split require the step c1 encoder-selection changes; this section does not claim those package changes. Windows/Linux hardware encoders listed by `encoders.ts` are outside the macOS build.

4. **Relocatable bundle and source offer.** `<out>/darwin-<arch>/` contains `ffmpeg`, `ffprobe` and their complete non-system dylib dependency closure in one flat directory. Install IDs and dependencies use `@loader_path/<file>`, rpaths are replaced with `@loader_path`, and modified Mach-O files are ad-hoc signed. Distribution signing remains the packager's responsibility. `LICENSES/<dependency>/` holds the selected licence texts; `source/` holds each exact verified source archive and a runnable copy of the build recipes under `source/build-scripts/scripts/`. `BUILDINFO.json` records versions, URLs, checksums, portable configure/build arguments, target architecture, build date, compiler and SDK version. Ship these directories with the binaries as the source offer; no fetch is needed to identify the corresponding source. For an offline rebuild, set `VIS_FFMPEG_CACHE_DIR` to the absolute `source/` directory before running its copied build script.

5. **Verification.** Run `node scripts/ffmpeg/verify.mjs <out>/darwin-arm64` on an arm64 Mac (or the x64 output on an Intel/Rosetta host with working VideoToolbox). It checks the licence and configure flags, architecture, signatures, `otool -L` and rpaths for every Mach-O, the complete required feature list, source hashes and licence texts. FFmpeg prints the licence with `-L`, while `-version` identifies the release and configuration. Functional checks exercise hardware-only H.264, OpenH264, AAC, actual ASS caption pixels via CoreText, the file-based timeline graph, transitions, mixing, concat stream copy, PCM waveforms, JPEG filmstrips, PNG extraction, silence detection, VP9 alpha pixels, ProRes 4444, checkerboard posters, MP3/Opus/FLAC and AudioToolbox AAC. The same checks run again after copying the whole bundle to a different temporary path, with ambient `DYLD_*` variables removed. `drawtext` is available through FreeType/HarfBuzz but the repository uses ASS for text, so no drawtext/fontfile path is required.

6. **Requirements inventory.** The survey covers `assets/src/{media,preview,timeline-render,alpha,encoders}.ts`, the mock/render providers, studiod media wiring and their media fixtures. The machine-readable acceptance list is [`scripts/ffmpeg/requirements.json`](../../scripts/ffmpeg/requirements.json). Names below are FFmpeg feature names (containers may have several filename aliases):

   - **Encoders:** `h264_videotoolbox`, `libopenh264`, `aac`, `aac_at`, `prores_ks`, `pcm_s16le`, `pcm_s24le`, `pcm_f32le`, `png`, `mjpeg`, `rawvideo`, `mpeg4`, `libvpx-vp9`, `libopus`, `wrapped_avframe`, `flac`, `libmp3lame`.
   - **Decoders:** `h264`, `hevc`, `libdav1d`, `vp8`, `vp9`, `libvpx-vp9`, `prores`, `mpeg4`, `mpeg1video`, `mpeg2video`, `png`, `apng`, `mjpeg`, `webp`, `gif`, `bmp`, `tiff`, `aac`, `alac`, `mp3float`, `flac`, `vorbis`, `opus`, `pcm_s16le`, `pcm_s24le`, `pcm_f32le`, `rawvideo`.
   - **Muxers:** `mp4`, `mov`, `ipod`, `webm`, `matroska`, `wav`, `image2`, `image2pipe`, `rawvideo`, `s16le`, `f32le`, `h264`, `null`, `framemd5`, `adts`, `ogg`, `flac`, `mp3`.
   - **Demuxers:** `mov`, `matroska,webm`, `wav`, `mp3`, `aac`, `ogg`, `flac`, `image2`, `image2pipe`, `png_pipe`, `jpeg_pipe`, `webp_pipe`, `apng`, `gif`, `rawvideo`, `concat`, `s16le`, `f32le`, `h264`, `mpegvideo`, `mpegts`, `ass`.
   - **Filters:** `crop`, `scale`, `pad`, `fps`, `setsar`, `tile`, `geq`, `format`, `split`, `asplit`, `null`, `anull`, `trim`, `atrim`, `loop`, `setpts`, `asetpts`, `settb`, `tpad`, `concat`, `xfade`, `premultiply`, `overlay`, `colorchannelmixer`, `fade`, `ass`, `aresample`, `aformat`, `volume`, `afade`, `adelay`, `amix`, `alimiter`, `apad`, `anullsrc`, `atempo`, `silencedetect`, `color`, `testsrc`, `testsrc2`, `sine`, `transpose`, `hflip`, `vflip`.
   - **Protocols:** `file`, `pipe`.

   Production outputs are H.264/AAC MP4, AAC M4A, ProRes 4444/PCM MOV, PCM WAV, PNG and JPEG, plus VP9-alpha WebM from rendering. Fixtures additionally encode MP3 through LAME, MPEG-4, Opus and raw pixels/samples and inspect `framemd5`/Annex B H.264. Import decoding covers PNG/APNG/JPEG/WebP/GIF (SVG is handled without FFmpeg), H.264/HEVC/AV1/VP8/VP9/ProRes/MPEG video, AAC/ALAC/MP3/Vorbis/Opus/FLAC/PCM audio, and the MP4/MOV/M4V, WebM/MKV, WAV/MP3/AAC/M4A/OGG/FLAC containers. Internal BMP/TIFF and MPEG transport decoders are retained as reasonable import headroom. All actual FFmpeg inputs are local files or pipes, so network protocols are disabled. The filters include automatic rotation helpers, preview checkerboards and source generators used by encoder trials and fixtures. Explicit `subtitles`/`drawtext` calls and HTTP FFmpeg inputs were not found.

Validation snapshot (arm64): the source build and both original/relocated verifier passes completed, including hardware-only VideoToolbox, OpenH264, ASS and VP9-alpha pixel checks. The media suites with this bundle first on `PATH` reported 1,821 passed, 13 failed and 57 skipped: the remaining failures are libx264-only fixtures or the package paths assigned to step c1 (four suite setup errors also prevent their dependent cases from running). No assertions were changed. The x64 build path is implemented but was not built or verified in this step; required native arm64 acceptance was prioritized.

After the merge with step c1 (2026-11-13), those package paths select their encoder through `SOFTWARE_FIRST_H264_ENCODERS`, the one libx264-only fixture input now uses MPEG-4, and the render-provider, scene-render and generation suites pass against this bundle (134 of 134); see "As built: step c1".

## As built: Windows FFmpeg (2026-11-13)

The Windows x64 media bundle replaces the third-party BtbN candidate with an in-house build of the same ten pinned components as macOS. `scripts/build-ffmpeg-windows.mjs` cross-compiles on Ubuntu 24.04 using the distribution's x86_64 mingw-w64 POSIX compiler. The selected C runtime is **MSVCRT**, the Ubuntu toolchain default; UCRT imports and compiler runtime DLLs are rejected. FFmpeg and the LGPL dependencies are shared so their DLLs remain replaceable. BSD libvpx is static inside avcodec because upstream does not support win64 shared builds. GCC's libgcc/libstdc++ and mingw-w64's winpthread are linked statically; their runtime exceptions and copyright notices accompany the bundle. BUILDINFO records exact installed toolchain package/source versions, and corresponding Ubuntu source packages (including GCC sources and distribution patches) join the source offer.

The ten component identities, versions, licences and hashes in `scripts/ffmpeg/sources.json` remain unchanged. The Windows-only manifest `scripts/ffmpeg/sources-windows.json` adds these release archives, verified by SHA-256:

| Component | Version | Licence | Purpose |
| --- | --- | --- | --- |
| nv-codec-headers | 13.1.15.0 | MIT | Header-only NVENC interface; NVIDIA driver loaded at runtime |
| AMF headers | 1.5.3 | MIT | Header-only AMD encoder interface; AMD runtime loaded at runtime |
| libvpl | 2.17.0 | MIT | Shared Intel oneVPL dispatcher for QSV; vendor implementation installed with the driver |
| zlib | 1.4 | Zlib | Static PNG/APNG decoding and PNG encoding support; macOS gets zlib from its SDK |

FFmpeg uses `--disable-gpl --disable-version3 --disable-nonfree --enable-shared --disable-static --disable-autodetect`, explicit dependency enables, Media Foundation, NVENC, AMF, oneVPL, D3D11VA and DXVA2. There is no x264/x265, network or ffplay. The maintainer-approved zlib addition supplies required PNG/APNG features with `--enable-zlib`; `--disable-iconv` avoids an unnecessary library absent from the Windows SDK. libass uses DirectWrite with fontconfig/CoreText disabled. Compiler/search flags are cleared, pkg-config searches only the private prefix, CMake uses Windows root-only library/include/package searches, and Meson uses an explicit cross file with `--wrap-mode nodownload`. Source checksums are verified before extraction. `--dry-run` works on any host: download and rehash every source, then print the environment, cross files, full build commands and runtime-source capture plan without compiling.

The output is staged at `<out>/win32-x64.partial` and renamed to `<out>/win32-x64` after verification of its dependency closure. Its exact layout is `ffmpeg.exe`, `ffprobe.exe` and all non-system DLLs flat at the root, `LICENSES/<component>/<file>` (including toolchain runtime notices), `BUILDINFO.json`, and `source/` containing every exact archive plus `source/build-scripts/scripts/{build-ffmpeg-windows.mjs,ffmpeg/}`. BUILDINFO includes configure flags, commands, compiler, toolchain, cross files and PE imports, replacing cache paths with `<prefix>`/`<work>`. Build-time objdump and the Node PE reader walk ordinary and delay imports transitively; only explicitly justified system DLLs or adjacent bundled DLLs may satisfy them. No system/vendor DLL is copied into the bundle. The existing source-offer format covers both platforms. The same output/cache/jobs environment variables as macOS apply.

`.github/workflows/ffmpeg-windows.yml` builds on `ubuntu-24.04`, then verifies on `windows-2022`. It permits manual dispatch and pushes only to `ffmpeg-build/**` for archive trial builds before the workflow reaches the default branch; newer branch runs cancel older ones. It has read-only contents permission, no secrets and no publication step. Complete build artifacts and verified release artifacts are retained for 90 days. The verified artifact contains `ffmpeg-win32-x64.zip` (everything except `source/`), `ffmpeg-source-win32-x64.tar` (the `source/` directory) and `SHA256SUMS`. Publishing remains a maintainer action.

Run `node scripts/ffmpeg/verify-windows.mjs <out>/win32-x64` on Windows. Verification checks pinned identities/source hashes/licences/recipes, LGPL configuration and version, every x64 PE import, shared DLLs and the common media requirements plus Windows encoder overrides; the macOS inventory and verifier are unchanged. Real media trials always exercise OpenH264 and native AAC, ASS pixels via DirectWrite, the timeline filter graph, concat, transparent VP9/overlay pixels, ProRes, PCM, image pipes, posters and MP3/Opus/FLAC. Media Foundation is attempted and explicitly skipped if the machine cannot provide an encoder. NVENC/QSV/AMF must be listed but are not required to have working GPU hardware on a hosted runner. The runtime is copied to a path containing spaces and all runtime checks repeat with a system-only DLL search PATH. The explicit `--smoke` mode skips source metadata for third-party comparisons, continues through independent check groups, and still exits nonzero on any failure; it cannot produce a verified release.

Local validation on the Windows development host covers all 14 source downloads/hashes, the dry-run command plan, offline unit tests and functional original/relocated trials against the existing BtbN bundle. That comparison is expected to fail its version3 configuration and stricter import policy. The in-house cross-build and acceptance of its actual DLLs require the GitHub Actions run; this section does not claim a successful cross-build before that run.

## Steps

- **a. Runtime prerequisites** in studiod and the host: data-directory default, ffmpeg and font paths, `ELECTRON_RUN_AS_NODE` for child Node spawns, shell `PATH` import helper. Testable without Electron.
- **b. Shell:** `apps/desktop` main process, studiod start/attach, in-process host, window hardening, native folder picker, single instance; unsigned local builds.
- **c. Packaging:** `electron-builder` config, better-sqlite3 for Electron, LGPL ffmpeg, fonts and licences, asar layout; clean-machine acceptance.
- **d1. Unsigned preview:** update feed, Windows auto-update, macOS update notice, studiod handover on update, preview labelling and install instructions; release script. Needs only the update host.
- **d2. Signed release:** Developer ID, notarization, Authenticode, publisher check and macOS in-place updates. Needs the signing prerequisites below.

## Maintainer prerequisites

Before step c:

- A source for LGPL ffmpeg builds. Windows: BtbN `win64-lgpl-shared` builds are a candidate, pending a check for libass. macOS has no well-known LGPL build, so step c adds an in-house build script for arm64 and x64 that keeps the exact source archive for the source offer.

Before step d1:

- An update feed host. GitHub Releases on the public repository is simplest, but depends on the RFC 0042 publish and visibility change and can be slow from mainland China; a separate public-read HTTPS bucket (for example Volcengine TOS, not the media-hosting bucket) is the alternative. Decided 2026-11-13: GitHub Releases (decision 6).

Before step d2:

- Apple Developer Program membership (annual fee) and a Developer ID Application certificate, plus an App Store Connect API key stored with `xcrun notarytool store-credentials`.
- A Windows code-signing option: Azure Artifact Signing (formerly Trusted Signing; individuals only in the US and Canada, organizations in a listed set of countries) or an OV certificate on a hardware token or cloud HSM.

## Decisions (maintainer, 2026-11-11)

1. **Shell:** Electron. Tauri was rejected for WebKit on macOS, a separate Node runtime and Rust.
2. **New dependencies:** `electron`, `electron-builder` and `electron-updater` are approved, scoped to `apps/desktop`.
3. **Transport:** the existing web host runs inside the main process over loopback. Electron IPC with a `vis://` protocol stays a later option.
4. **Render jobs on Macs without Chrome:** keep system browsers, with a clearer error linking to the Chrome download page.
5. **macOS architectures:** separate Apple silicon and Intel builds; the updater picks the matching one.
6. **Update host (maintainer, 2026-11-13):** GitHub Releases on the public repository (`public` remote), not the archive. Previews are pre-releases carrying the DMG and the exact LGPL source archives, and `VIS_FFMPEG_SOURCE_URL` points at that release's source asset. While the public repository is private, testers are added as read collaborators and update by downloading the new DMG; `electron-updater` reads the feed once the repository is public, because a private feed would need a token inside the app. A release tag points at the `release-public.mjs` snapshot the build came from. A bucket mirror is added only if download speed from mainland China requires it.
7. **Release stages:** ship an unsigned preview (d1) before buying signing certificates; signed releases (d2) follow once the accounts exist.
