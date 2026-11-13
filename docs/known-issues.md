# Known issues

Open problems we have seen and chosen to handle later. Remove an entry once its fix has been validated on the affected platform. Windows entries remain open after macOS-only fixes.

## Maintainer to-do: manual and paid acceptance

Checks that only the maintainer can run, because they need real Agents, real keys or paid services. Each paid run needs explicit approval, an isolated data directory and tightened daily limits in `providers.json` (see AGENTS.md). Tick an item by removing it here and recording the result in its RFC.

- [ ] **RFC 0028 real-API acceptance** for Kling, OpenAI Images, Alibaba Wan and Gemini with the maintainer's keys; MiniMax passed on 2026-11-08.

## Windows validation

**Status on 2026-11-07:** the failure that blocked stability acceptance is fixed. `queue()` built full views of every work item twice per event flush, which blocked the event loop; it now reads only queued items, and recall to next-item start fell from 800–1073 ms to about 310 ms. On Windows, `563d249` passed `pnpm check`, build and two consecutive full e2e rounds, after four clean rounds at four workers on the timing fix. The results below are the history that led here. GitHub's `windows-2022` runner is a separate matter: it still fails three unit tests at `563d249` (Gemini `content_blocked`, the render provider's local Chrome and ffmpeg case, and Claude process-tree cleanup).

Latest Windows rerun: 2026-11-06 on `13945ca`, on the same machine and toolchain. Studiod and the web host were stopped first. **Stability acceptance has not passed:** the required two consecutive full e2e rounds did not occur, although the same revision reached them on 2026-11-05. No product code, assertions, timeouts or worker defaults were changed. Tests used isolated temporary data, fake Agents and local/mock providers.

| Check | Result |
| --- | --- |
| `pnpm check`, default four Windows workers | 236 files passed, 2 skipped; 3,019 tests passed, 18 skipped; no unhandled errors |
| `pnpm build` | Passed |
| Full e2e, round 1 | All 42 files and 307 tests passed; 232.19 s |
| Full e2e, rounds 2, 3 and 4 | Each 41 files passed, 1 failed; 306 tests passed, 1 failed; 199.37 / 198.86 / 210.14 s |
| `work-board.e2e.ts` alone, five runs | All 17 tests passed each time |
| Agent cleanup, one-worker focused rerun | All 69 tests passed |
| Session panel alone | All 21 tests passed |
| Writing preview alone, normal / 6x CPU throttle | All 8 tests passed in each run |
| Real ZIP staging and open-handle checks | All 6 supplemental tests passed, with the same accept, reject and lock results recorded below |

All three failures were the same case, `work-board.e2e.ts:597` (queued work after recall), fixed as described above. The `session-panel.e2e.ts` teardown `EPERM` from 2026-11-05 did not recur in these four rounds, and no log contained `EPERM`, an unhandled error or a database-closed rejection. That does not close it, because the cause is unproven. Logs are under `%TEMP%\vis-windows-rerun-2026-11-06`. This rerun did not repeat the performance harness, LGPL-build work or real-Agent acceptance.

### Windows rerun on 2026-11-05

Rerun on 2026-11-05 on `13945ca`, on the same machine and toolchain described below. The frozen dependency install and four caption-font checksum checks passed. No product code, assertions, timeouts or worker defaults were changed during validation. Tests used isolated temporary data, fake Agents and local/mock providers.

| Check | Result |
| --- | --- |
| `pnpm check`, default four Windows workers | 236 files passed, 2 skipped; 3,019 tests passed, 18 skipped; no unhandled errors |
| `pnpm build` | Passed |
| Full e2e, round 1 | 307 tests passed, but `session-panel.e2e.ts` failed during teardown; 41 files passed, 1 failed; 196.96 s |
| Full e2e, round 2 | All 42 files and 307 tests passed, no skips; 165.93 s |
| Full e2e, round 3 | All 42 files and 307 tests passed, no skips; 168.50 s |
| Agent cleanup, one-worker focused rerun | All 69 tests passed across Claude disposal, Codex adapter and real fake-process tree tests |
| Session panel alone | All 21 tests passed; 49.70 s |
| Writing preview alone, normal / 6x CPU throttle | All 8 tests passed in each run; 3.84 s / 4.62 s |
| Real ZIP staging and open-handle checks | All 6 supplemental tests passed; 19.24 s |

The required check/build/two-consecutive-full-e2e sequence passed in rounds 2 and 3. The first round's teardown failure remains open: `session-panel.e2e.ts:109` failed removing `%TEMP%\vis-work-projects-9TleG0` with `EPERM` through `removeTempDir`, which already uses ten retries. All 21 tests in that file had passed. Its standalone rerun and the next two full rounds passed. The lock owner and cause are unproven. A final read-only process inventory found no matching test fake-Agent, MCP CLI, studiod or web-host processes.

Windows verification of the prepared fixes:

- **Unit load and cleanup:** no Chrome 30 s teardown timeout, media/gateway timeout, media-directory `EPERM` or database-closed rejection occurred in the full check. The Claude delayed-finalizer and Codex delayed-exit/startup/probe regressions passed. All three adapters killed interruption-resistant fake processes and their descendants, and immediately removed their work directories, both in the full check and the serial focused run. Daemon shutdown also left no fake Agent descendant alive.
- **Long manuscript:** all three full rounds passed the 217,300-character case, bounded text/outline DOM, current-chapter visibility and persisted typed-text checks. Close plus saved-text verification took 69.27 / 53.06 / 58.54 ms. Alone it took 55.30 ms normally and 212.21 ms at `VIS_WRITING_CPU_RATE=6`, keeping the eight-second click timeout.
- **Skills:** the old ZIP-limit and open-file failures are now validated as fixed on Windows, with exact samples and persistent/transient lock results below. Editor-specific sharing behavior still needs hands-on acceptance.

Logs, per-run writing measurements, the supplemental reproduction script and its JSON results are under `%TEMP%\vis-windows-fixes-2026-11-05`. This rerun did not repeat the prior timeline performance harness, LGPL-build work or real-Agent acceptance.

### Earlier Windows baseline at `847a32a`

Earlier run: 2026-11-05 on `847a32a`, using Windows 11 Pro build 26200, an i7-12700KF (20 logical processors), 16 GiB RAM and an RTX 3070 Ti. Node 24.14.0, pnpm 10.34.9, Chrome 157.0.8103.39 and winget's Gyan.FFmpeg 9.0.2 full build were installed. The frozen dependency install and all four caption-font checksum checks passed. Stability acceptance had not passed at that revision. No product code, assertions or timeouts were changed. Full suites used their default worker counts; the focused unit rerun explicitly used one worker.

| Check | Result |
| --- | --- |
| `pnpm check` | 2,983 passed, 2 failed, 18 skipped; 3 failed files and 1 unhandled rejection |
| Focused unit rerun, one worker | 147 passed, 1 failed across 4 files; Claude process cleanup still failed |
| `pnpm build` | Passed |
| Full e2e, round 1 | All 42 files and 307 tests passed, no skips; 169.14 s |
| Full e2e, round 2 | 41 files passed, 1 failed; 306 tests passed, 1 failed, no skips; 171.57 s |
| Failed e2e file alone | `writing-preview.e2e.ts`: 7 passed, 1 failed at the same close-button action |
| Timeline performance harness | 7 measurements passed, LGPL case skipped; renderer memory exceeded the report's target |

The first run on 2026-11-04, before RFC 0031 step b, had 2,835 unit tests pass, 18 skip and three Chrome-close hook failures; build passed, then e2e had 252 passes and 251 passes / one failure. Those failed files passed alone. The table above records the subsequent `847a32a` baseline, retained as failure evidence.

Failures at `847a32a`, before the fixes verified above:

- **Closing Chrome:** `agent-loading-render.test.ts` still exceeded its increased 30 s `afterAll` budget. It passed in the focused one-worker rerun. `library-series-render` and `timeline-editor-render` did not fail this time. The cause of slow closing remains unmeasured.
- **Media and gateway:** the video/audio stream-probing case and series caller-rules case exceeded their 5 s test budgets in the full run. Media cleanup also reported `EPERM` on its temporary directory. Both files passed in the focused rerun.
- **Claude process cleanup:** `turn-process.test.ts` produced an unhandled `The database connection is not open` rejection from Claude's `consume` / `exitInstance` after the full run. Alone with the other failed files, the Claude case failed deleting its temporary work directory with `EPERM`. Codex, DeepSeek and the daemon-shutdown cases passed. See Agent shutdown validation below.
- **Long manuscript close:** `writing-preview.e2e.ts:232` timed out after 8 s clicking **Close writing page**, after typing and navigating a 200,000-character manuscript. It passed in round 1, failed in round 2 and failed again with that file alone. The isolated call log resolved the button and waited for it to be visible, enabled and stable. Cause remains unproven; do not classify it as only full-suite load.

Additional checks completed in that earlier run:

- **Media:** ffmpeg is newer than the required version 7 and lists `libvpx-vp9`, `prores_ks` and the ASS filter. Transparent render, checkerboard/browser-alpha preview, MOV export/download/cancel/retry and timeline overlay tests passed. Preview screenshots were visually checked. Missing-encoder tests use simulated encoder lists; this installed build has both encoders. This is the Gyan GPL full build, not the pending LGPL build or Chocolatey's CI `ffmpeg-full`.
- **Fake-Agent workflows:** silent-turn Stop / Send now, approval of running-child cleanup, Skills library/copy UI, manuscript import/review and real local blockout render/frame extraction with even splitting passed in both e2e rounds. These use real studiod, Chrome and local rendering, but scripted Agents; they do not establish real-Agent acceptance.
- **Skills limits and open files:** supplemental tests against the real staging and library services found the two issues below. Reserved `CON` metadata was rejected. Publishing with a read handle open passed; update and reset failed safely and succeeded after closing the handle.
- **Timeline performance:** with no CPU throttling, warm opening of 50 clips took a median 103 ms, playback first frame 31 ms, and three clip boundaries produced 0 black frames out of 2,610 samples. Stream-copy export took 3,665 ms; a one-minute 1080p30 re-encode took 7,667 ms with `h264_nvenc` (7.83x realtime). Renderer memory after playback was 549 MB private / 590 MB working set, above the report's 500 MB target; after closing the editor it was still 506 MB private / 546 MB working set. This is one measurement, not proof of a leak or minimum-spec acceptance. The harness measures rather than enforcing target numbers. Its first run completed the seven measurements but failed writing its report with `ENOENT`; after precreating the output directory, a second run saved the report and passed. Why the first output directory was missing is unresolved.
- The earlier `session-results.e2e.ts` loading race, `work-agents.e2e.ts` directory `EPERM`, board waits and timeline source-edge failure did not recur in either full e2e round.

Logs, the supplemental reproduction script and `perf/report-path-cpu1.md` / `.json` are under `%TEMP%\vis-windows-validation-2026-11-05`; transparent screenshots and downloaded MOV samples are under `%TEMP%\vis-next\rfc36`. All runs used isolated temporary data, fake Agents and local/mock providers.

Remaining Windows acceptance work:

1. Identify the intermittent session-panel project-directory lock from the `13945ca` rerun. Continue performance-under-load investigation, including the earlier 549 MB renderer private-memory result and the missing performance-output-directory incident.
2. **Hands-on:** real pen/tablet pressure, the panel right-click menu, editor-specific file sharing, and author-supplied `.docx` / GB18030 `.txt` manuscript samples. Synthetic import tests are not this acceptance.
3. **Real Agents:** explicitly approved, isolated Codex / DeepSeek / Claude Code runs confirming Stop, Send now, recall, deletion, descendant exit and work-directory release. No real Agent or vendor request was made in this validation.
4. **Other environments:** the Windows LGPL ffmpeg build, CI's Chocolatey `ffmpeg-full`, and a real minimum-spec / no-usable-GPU machine.

### Fix preparation and regression coverage

- **Chrome teardown and budgets:** Windows unit workers are capped at four to limit concurrent Chrome/ffmpeg/SQLite fixtures on the 16 GiB host. The Chrome 30 s teardown budget is unchanged; slow teardown's original cause remains unproven. The stream case (fourteen local subprocess launches) and series caller case (three real RPC clients and two SQLite projects) get Windows-only 20 s budgets, with assertions unchanged. Media tools already wait for process `close`. These paths passed the Windows full check at `13945ca`; the earlier media cleanup `EPERM` did not recur.
- **Claude / Codex cleanup:** independent lifetime tracking retains Claude startup tasks and consumers after force-end admission is released, and disposal awaits final recording and OS exit. Codex termination now awaits exit, and disposal retains pending tree kills, startup recording and already-finishing catalog probes; failed spawns without exit events also settle. Two Claude delayed-finalizer tests and three Codex exit/startup/probe tests fail against the pre-fix adapters and pass with the changes. Fake-process tree tests now pass on Windows as well as macOS. DeepSeek's `0415f92` finalizer was audited; Windows fake-process taskkill/cwd release passed, while real-Agent acceptance remains open.
- **Long manuscript close:** reproduced on macOS at 6× CPU throttling with the same eight-second click timeout. A Chrome CPU profile measured 8.4 s in accessible-name computation before the click across the 5,300-heading outline; no save-on-close or settling-layout fault was established. The outline now windows its rows and follows the caret on navigation. The throttled macOS case closed and verified saved text in 167 ms. The Windows rerun above confirms bounded text/outline DOM, current-chapter positioning and saved text, including at 6× throttling.

macOS preparation evidence: `pnpm check` passed 3,019 tests (18 platform skips), build passed, then two consecutive full e2e rounds passed all 307 tests across 42 files with no skips (145.42 s / 145.67 s). Windows results are recorded separately above.

All five requested Windows reruns were completed at `13945ca`: full check/build/e2e, serial Agent cleanup, standalone and throttled writing preview, full-load media/gateway/Chrome checks, and real ZIP/open-file reproductions. The first-round session-panel teardown `EPERM` remains a separate open finding.

### Skill ZIP acceptance and earlier failure evidence

At `847a32a` on 2026-11-05, RFC 0017 and `skills.ts` had raised source limits to 256 MiB archived, 512 MiB unpacked and 10,000 files, but `readSkillZip` called `readZip` without overriding its 50 MiB / 2,000-file defaults. Real Windows staging rejected a compressed archive with a 51 MiB unpacked payload and a 2,001-file archive. A 267,648,022-byte archive containing 535,832,444 unpacked bytes and 9,999 files, all within the new limits, also failed with `skill.zip.declared_size_limit` at 50 MiB.

Validated fixed on Windows at `13945ca`: protocol's shared `SKILL_SOURCE_LIMITS` reaches folder staging and the skill ZIP parser; manuscript limits remain unchanged. All three original generated samples now stage and import successfully, including the exact archive/unpacked byte counts and 9,999 files above. Real staging rejects an archive of 268,435,457 bytes, an unpacked total of 536,870,913 bytes and 10,001 files with the appropriate stable reasons. The full unit check also passes the parser's below/at/above boundary tests. This Windows pending-fix entry is closed; its reproduction history is retained here.

### Skill copy lock acceptance and earlier failure evidence

At `847a32a` on 2026-11-05, real Windows `openSync(path, 'r')` handles caused update and reset to fail with raw `EPERM` at the `renameSync` replacement in `skill-library.ts:124`. Publishing succeeded. Failed replacement preserved the original bytes, and retry succeeded after the handle closed.

Validated fixed on Windows at `13945ca`: update/reset share the eight-attempt atomic replacement policy, with seven waits totalling 1.27 s and an author-approved hash check before each attempt. A worker held a real read handle and released it after 120 ms; update and reset succeeded during retries in 201.96 / 208.67 ms. With a persistent real handle, both operations returned localized `skill.copy_file_locked` after about 1.34 s. English and Chinese messages were verified; original bytes, origin metadata and event sequence were preserved, and no `.updating-*` files remained. Both operations succeeded after closing the handle. Publishing with the handle open succeeded, and reserved `CON` metadata was refused. This Windows pending-fix entry is closed for these real-handle cases; particular editors' sharing modes remain hands-on work.


## Occasional `timeline.e2e.ts` failure

Seen in two separate macOS full rounds; first recorded on 2026-11-04. "orders selected shots…" timed out waiting for a source edge (line 148) even though the server's timeline `inputs` were correct and the screenshot showed its clips. The next case's Out of date timeout (line 192) is a consequence: it reuses that timeline, but the Agent edit that makes it outdated is after the failed edge assertion and never runs. The file has passed alone and in later full rounds. Cause remains unproven; no timeout or assertion has been relaxed.

A related failure appeared on Windows on 2026-11-07 at `70624c1`, in `canvas-organization.e2e.ts:623`: a local render succeeded and produced its video, but the source edge did not become visible within five seconds, in the second of two full rounds at two workers. The file then passed six consecutive standalone runs. The same round pair's first attempt ended on the session-panel project-directory lock (`EPERM` while removing `vis-work-projects-*` after all 319 tests passed).

Investigation on 2026-11-05 at `c92dd30`:

- Viewport culling is ruled out: the canvas does not enable React Flow's `onlyRenderVisibleElements`. Every non-frame card mounts all four input and output handles, so changing the chosen edge side does not add or remove handles.
- The creation writer stores timeline inputs before reading the full `node.created` view. Both `node.setMeta` and snapshots read the same full view, including inputs; the client stores complete node events and snapshots without stripping them. No missing-input path was found by inspection.
- Temporary tracing recorded client node inputs, computed edge props, controlled-node measurements and React Flow's internal handle bounds. Fifteen standalone file runs passed, using at most two concurrent copies: one with 4× Chrome CPU throttling, ten with 6×, and four with 20× plus 25 immediate metadata writes after creation. A normal four-worker full e2e round also passed (264 tests, 7 skipped). The source-edge failure reproduced in 0 of these 16 runs.
- In every captured run, the client kept all three timeline inputs through rename, React Flow received the three source edges, and every measured media/timeline card had all four source and target handle bounds. Edge reuse did not drop the edges. These successful traces do not rule out a rarer measurement or delivery race in the original failures.

All production diagnostics were removed; product code is unchanged. The source-edge assertion now saves `failure-orders-selected-shots-connects-sources-exports-inline-and-marks-Agent-edits-out-of-date.edges.json` beside its failure screenshot in the temporary `vis-0024-A3` directory, then rethrows the original failure. It reads the committed React props and existing React Flow store without installing production hooks, recording client inputs, computed/stored edge IDs and handles, rendered edge count, internal handle bounds and DOM handle rectangles. The collector was checked against a clean production build (five client nodes, three computed/stored/rendered edges, four source and four target handles per node). A failing capture is still needed before choosing a fix; repetition under CPU load alone did not reproduce it.

## three.js blockouts on Windows

Passed on the machine above with default Chrome flags, through D3D11 hardware rendering. No WebGL context loss, and extracted frames looked right.

| 5 s at 30 fps | Two runs | Repeat renders |
| --- | --- | --- |
| 1920×1080 | 8.09 s, 8.15 s | All 150 frame hashes identical |
| 1280×720 | 5.01 s, 4.73 s | All 150 frame hashes identical |

Still unverified: machines without a usable GPU, where Chrome may fall back to software rendering. If that fails, blockouts there fall back to CSS 3D and the `previz` guide must say so.

## Manuscript revision growth

Every autosave stores the whole text body. A simulated ten minutes of typing on a 200,000-character document added 33.8 MiB to the database (20 revisions), about 200 MiB an hour (RFC 0031, 2026-11-04). Short chapters are barely affected. Fixing it means coalescing history, including events and operations, which needs its own design.

## Agent shutdown validation

RFC 0035 retains Codex processes until exit and hard-kills owned process groups on forced termination and disposal. Windows validation at `847a32a` on 2026-11-05 exposed Claude's late database access and work-directory `EPERM`. The fixed lifetime tracking was validated on Windows at `13945ca` in the full check and the one-worker focused run: delayed-consumer/kill regressions passed, and all three adapters' interruption-resistant fake processes and descendants exited before immediate directory removal. Daemon shutdown also passed. The separate session-panel e2e teardown lock above remains open. Real Codex, DeepSeek and Claude Code shutdown acceptance remains unverified.

## Oversized writing tables

The writing page renders tables near the viewport and reveals their source for editing, review and shot anchors. Tables exceeding 200 Markdown source rows or the 24,000-character local scan remain editable source text, keeping table DOM and scanning bounded on large manuscripts. This fallback was accepted for real-use round 2 on 2026-11-05; row virtualization is deferred.

## Ghosting when opening shot previz

Reported 2026-11-05 from real use: clicking **Open shot previz** on a canvas card shows a ghost image. Not reproduced yet: frames captured over the first second after opening were clean, but the test used solid-colour panels. Still unknown is where it appears (panel picture, panel list or the whole page), whether it is a brief flash or stays, and whether it needs real pictures, sketches or blockout frames. Next step: reproduce with a real project, or capture a screenshot when it next appears.

## Video fallback during a long preview queue

A video node keeps or mounts a live video while its poster is not ready, so it never shows an empty frame. Posters share one preview queue with filmstrips and peaks. Opening a canvas with many video nodes while that queue is busy can therefore mount many videos at once, and they stay mounted until their posters arrive. Giving posters priority in the queue is the likely fix.

## Intermittent edge check in the browser suite

`web.e2e.ts:533` failed once in eight full runs on 2026-11-07, after the flush fix: the server had the generated node, and the browser did not draw the new edge within a second. It has not recurred. Whether this is slow rendering or a race is unknown.

## Project roots that contain the app data directory

Auto-approval (RFC 0015) trusts the session work directory and project directory. If an author picks a root that contains the app data directory, an Agent's auto-approved writes also reach the databases, tokens and `render-libs`. Default locations keep them apart, and the READMEs tell authors to keep app data outside project folders. Excluding the data directory from auto-approval needs its own change.

## Video reference fetch timing not measured

RFC 0043 (merged 2026-11-10): a real Seedance job with a TOS-hosted video reference succeeded on 2026-11-11 (see RFC 0043 §9), so Ark's video task endpoint does read a TOS presigned GET URL. Still unmeasured: how soon after submission Ark fetches it. Native macOS Keychain writes passed on 2026-11-11 (see RFC 0043 §9). Windows PasswordVault writes were checked by hand on 2026-11-10 against the `vis-creative.hosting.test` entry (absent, set, read back with quotes, `$( )`, backticks and Han characters, overwrite, delete, repeat delete). The 6 h default task window is a guess until that run. Deleting the hosting secret outside the app stays undetected until the next upload, which then fails with `hosting.upload_failed`.

## Media hidden before the working-purpose guard

Since 2026-11-10 the gateway refuses agent writes that mark image, video or audio nodes as `working` (RFC 0016), because such media only appeared after **Locate**. Media an agent hid this way earlier is not migrated; find it with **Locate** and ask an agent to set its purpose back to artifact, which the guard allows.

## Native image view not in the transcript

RFC 0037 closed on 2026-11-11. When Codex says it inspected a rendered image or extracted frames, the product transcript cannot confirm it, because Codex's native image viewer does not emit a tool event the adapter records. Authors should check renders themselves rather than rely on an Agent's report that it looked. Recording native viewer activity needs adapter support.

## Gemini Omni 1.1 routes to 1.2 from 2026-12-03

Found while checking RFC 0045 links on 2026-11-11: Google's Omni guide says requests to `gemini-omni-1.1-flash` route to `gemini-omni-1.2-flash` from 2026-12-03, and the guide documents 1.2. The Gemini adapter registers only 1.1, whose parameter schema was checked against the 1.1 docs. Before that date, add 1.2 from its official documentation and check whether the 1.1 schema still holds; Gemini also still awaits real-API acceptance (RFC 0028).
