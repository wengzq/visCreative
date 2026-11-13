# RFC 0043: Video references and media hosting

Status: accepted (maintainer, 2026-11-10). Resumes RFC 0029 step e (§9), which was put on hold on 2026-11-04. Accepted with the 6 h task window and 7 h link lifetime of §3, TOS-only hosting first, and the single paid acceptance run of §9 after the build. Steps a–d implemented and merged on 2026-11-10; step e (paid acceptance) passed on 2026-11-11 (§9); fetch timing is still unmeasured.

## Background

Every adapter rejects a video input today (`packages/generation/src/providers/ark/index.ts`, `inputImages`). The models are not the limit: Seedance 2.0 and 2.5 on Ark, Kling 3.0 Omni and 4.0, the MiniMax H3 family, Gemini Omni and several Wan models all accept video input in some form. Authors want to hand a clip to a video model as a camera, motion or content reference, for example a previz blockout or an earlier take.

The obstacle is delivery. visCreative keeps media on the author's machine and sends images and audio inline as base64. Ark documents video only as a public URL or an `asset://` id, and the `asset://` route itself takes a URL, needs separate AK/SK credentials and is meant for virtual portraits (RFC 0029 §9). So a local clip needs somewhere reachable to live for the duration of a task.

Vendor documentation was checked on 2026-11-10 (sources in the appendix). Nothing was tried against a real API.

## Goals

- An optional **media hosting** setting: the author's own object storage bucket, used only to hand a local file to a vendor for one task.
- **Seedance 2.0 and 2.5 accept reference videos** through that hosting, with their documented limits checked locally before any upload or paid call.
- **Register Seedance 2.5** (`doubao-seedance-2-5-260628`) with its own settings and limits.
- A mechanism other adapters can reuse: an adapter asks the host for a short-lived URL to a pinned local file and never learns the hosting credentials.

## Out of scope

- Video edit and extend tasks (Seedance 2.5 `edit`/`extend`, Kling `base_video`, Gemini `edit`/`extend`, Wan `first_clip`). This RFC sends reference videos only.
- Other vendors' video inputs. They are later steps, listed in §8 with what each needs.
- Generic S3-compatible hosting. The first hosting type is Volcengine TOS with its native signature, because that is the URL form Ark documents reading (§3). The setting has a `type` field so S3 can be added.
- Batch shot generation choosing video references per shot (RFC 0029 §9 mentions a batch option). Single submissions from the canvas, the prompt panel and agents come first.

## Product principle check

- Hosting is mechanism: where a file goes and how long it stays. Whether to use a video reference, and which, stays the author's or the Agent's proposal.
- Nothing is uploaded without the author having configured hosting themselves. With no hosting, a video reference is refused before quota with a message that names the setting; no default bucket and no vendor-side storage is used behind the author's back.
- The settings page states plainly that a referenced clip leaves the machine, is stored in the author's bucket for the task's lifetime and is readable by anyone holding the signed link until it expires.

## Design

### 1. Hosting setting

`HostingConfigSchema` describes an optional, independent media hosting configuration saved in `<dataDir>/hosting.json`. `ProviderConfigSchema` has no hosting field and `providers.update` rejects one. The hosting file contains only these non-secret settings:

```ts
type HostingConfig = {
  type: 'tos'
  region: string          // e.g. 'cn-beijing'; selects the endpoint tos-<region>.volces.com
  bucket: string
  accessKeyId: string     // not secret on its own
  prefix: string          // object key prefix, default 'vis-creative/refs/'
}
```

- Hosting saves use an atomic replacement with mode `0600`, independently of `providers.json`; `hosting.update` is the only UI write path and accepts `config: null` to remove the hosting file. Provider settings are rebuilt from `providers.list`, which deliberately omits hosting details, so their saves must never replace hosting configuration. Missing, unreadable, malformed or schema-invalid `hosting.json` makes hosting unavailable only: leave the file untouched and continue loading providers normally.
- Region matches `^[a-z]+-[a-z0-9-]+$`. Bucket names are 3–63 lowercase letters, digits or hyphens, with no leading or trailing hyphen. Access key IDs are non-empty and contain no whitespace or null characters. Prefixes are at most 200 characters, relative, end with `/`, and consist only of `[a-z0-9._-]+` segments separated by single `/`; `.` and `..` segments are forbidden. Whitespace, control characters, backslashes, query/fragment delimiters and percent escapes are not allowed.
- The **secret access key** lives only in the system credential store, under its own service name `vis-creative.hosting` (account = hosting type, `tos`). On macOS it is written through stdin to `security -i` and read with `find-generic-password -s vis-creative.hosting -a tos -w`; on Windows through `PasswordVault`, resource `vis-creative.hosting`, exactly as provider keys are. Tests use only `vis-creative.hosting.test` and delete it in `finally`. A separate service name avoids any clash with a provider id and keeps the "never read real `vis-creative.provider` entries" rule simple. AGENTS.md's security rules are updated to name both services.
- Changing `accessKeyId`, or saving without a valid previous configuration, clears the stored secret before writing the configuration and requires a new secret before hosting becomes ready. A failed deletion leaves the configuration unchanged; if the subsequent file write fails, hosting stays unavailable with no secret. Changes to region, bucket or prefix keep the secret. The settings UI confirms the clearing only when the author saves. `hosting.setSecret` requires a valid saved configuration; until then its input is disabled with a save-first hint.
- Studiod caches parsed hosting configuration until a hosting mutation; hand edits need a restart. A successful credential write remains successful if the subsequent presence check fails: readiness becomes unknown and is retried at most once every 30 seconds.
- Methods, UI callers only (`protocol/methods.ts`): `hosting.get` (config plus `hasSecret`), `hosting.update`, `hosting.setSecret`, `hosting.clearSecret`, and `hosting.test`. Agents cannot read or change hosting; they only see, through `providers.list`, whether video references are currently usable (§5).
- `hosting.test` uploads a 1 KB object under the prefix, reads it back through a presigned GET, deletes it, and reports which step failed. It never returns the URL or the secret.
- Settings UI: a "Media hosting" section in the provider settings page with region, bucket, access key id, prefix, a write-only secret field, a Test button, the disclosure above, and a recommendation to add a bucket lifecycle rule that deletes objects under the prefix after 3 days (the backstop for §3 cleanup). On Windows the existing key-configuration disclosure applies here too.

### 2. Host-side upload service

A new module in `services/studiod` owns hosting; adapters get a narrow interface through their create context:

```ts
type HostedInputs = {
  /** Upload (or re-upload) a pinned local file and return a presigned GET URL valid for ttlSeconds. */
  url(input: { path: string; mime: string; key: string }, ttlSeconds: number, signal?: AbortSignal): Promise<string>
  /** Delete everything uploaded under this key. Idempotent. */
  release(key: string): Promise<void>
  /** Removes the access key id, signatures and presigned URLs the host knows of. */
  redact(text: string): string
  readonly configured: boolean
}
```

- url() key = `${idempotencyKey}:${ordinal}`; release() takes the bare idempotencyKey. The host splits at the last colon and hashes only the bare key. Object names are `<prefix><sha256(idempotencyKey)>/<ordinal>.<ext>`: deterministic, so a retried attempt overwrites the same objects and cleanup needs no stored list; per job, so one job's cleanup never deletes a file another job is still using.
- Signing is done in-process with `node:crypto` (TOS `TOS4-HMAC-SHA256`, virtual-hosted style `https://<bucket>.tos-<region>.volces.com/<key>`). Uploads use a header-signed `PUT`; the vendor gets a query-signed `GET`. No new dependency.
- **A presigned URL is a secret.** It never reaches the database, job records, the Ark submission record, logs, events, error messages or anything an agent can see. Errors from TOS or a vendor are redacted for the URL, its signature and the access key id before they leave the adapter, in the same way Ark already redacts its API key (`vendorError`/`containsKey`).
- The service reads the secret per call through the credential store and keeps it only in memory for that call.

### 3. Seedance video references (Ark adapter)

Request item, per Ark's create-task API: `{ type: 'video_url', video_url: { url }, role: 'reference_video' }`.

**Order of operations in `submit`:**

1. Validate inputs locally (§4). Hosting not configured → `rejected`, reason `generation.video_reference_hosting_required`.
2. Upload each reference video and obtain its URL. An upload failure happens before the intent record and before the paid create, so it is `transient` and safe to retry. If an upload fails, release the request's uploaded objects best-effort before propagating the failure; the bucket lifecycle is the backstop when hosting is unavailable. Reject a requested link lifetime beyond the hosting maximum locally as invalid parameters.
3. Write the `submitting` intent record, then POST, as today. The record never contains URLs.
4. `cleanup` (already called after durable settlement) calls `hosted.release(key)`.

**URL lifetime.** Ark does not document when it fetches a reference URL, and a task may wait in Ark's queue until `execution_expires_after` (default 48 h). When a request carries reference videos, the adapter sets `execution_expires_after` to the author's value or 21600 s (6 h) if unset, and presigns for that value plus 1 h. A task Ark cannot start within that window expires and is not billed. The 6 h default is a guess to confirm in acceptance (§9).

**Seedance 2.5 task type.** 2.5 decides between reference, edit and extend from the prompt when `omni_reference_task_type` is `auto`; a reference prompt that happens to say "replace" could be treated as an edit. The adapter always sends `omni_reference_task_type: 'reference'` for 2.5 requests with reference inputs.

**Prompt naming.** 2.0 documents `视频1`/`图片1`/`音频1`, numbered per type in `content` order; 2.5 documents `@视频1`/`@图片1`/`@音频1`. Submission resolves node markers through the adapter's model-specific reference-label hook; handwritten identifiers are preserved. The `generation` guide tells agents to prefer markers and explains each model's literal syntax.

**Real faces.** Ark rejects uploaded reference images and videos showing real faces on both models. A vendor refusal maps to the existing `generation.moderation_rejected`; the guide mentions it.

### 4. Limits, checked before quota

`ProviderInputMetadata` gains the fields the pinned asset version already stores: `width`, `height`, `fps`, and `bytes` (from the blob). `submit.ts` fills them for direct and slot inputs. Ark's `validateInputs` then checks, per model:

| | Seedance 2.0 (`-fast`, `-mini`) | Seedance 2.5 |
|---|---|---|
| Reference images | ≤ 9 | ≤ 30 |
| Reference videos | ≤ 3; 2–15 s each; ≤ 15 s total | ≤ 10; 2–30 s each; ≤ 30 s total |
| Reference audio | ≤ 3; 2–15 s each; ≤ 15 s total | ≤ 10; 2–30 s each; ≤ 30 s total |
| All inputs | — | ≤ 50 |
| Audio without image or video | rejected (today's rule) | allowed |
| Video file | mp4 or mov (`video/mp4`, `video/quicktime`), ≤ 200 MB, 24–60 fps, aspect 0.4–2.5, 407,696–8,295,044 pixels | same |

- Codec (H.264/H.265) is not in our metadata; a wrong codec surfaces as Ark's refusal.
- Reference inputs (images, videos, audio) cannot be combined with first-frame or first-and-last-frame modes on either model (existing `generation.frames_reference_mix`). A request with a video reference uses `role: 'reference_image'` for every image, as the audio rule does today.
- The hard-coded "9 images for video" shortcut in `submit` and `referenceImageLimitFor` become per-model.
- Each limit fails with its own reason (`generation.video_reference_count`, `_duration`, `_total_duration`, `_format`, `_size`, `_fps`, `_dimensions`), with Chinese and English messages in `error-messages.ts`.

### 5. Contract

- Hosting configuration has its own `HostingConfigSchema` and `hosting.json`, separate from `ProviderConfigSchema` and `providers.json`. `hosting.get` returns `{ config: HostingConfig | null, hasSecret: boolean }`; `hosting.update` returns the same shape. `hosting.setSecret` and `hosting.clearSecret` return only `{ hasSecret: boolean }`. Provider updates reject hosting fields, and invalid hosting files cannot disable provider configuration.
- `providers.list` models gain `referenceInputs?: { image: number; video?: { max: number; minMs: number; maxMs: number; totalMs: number; requiresHosting?: boolean }; audio?: {…}; total?: number }` from a new adapter hook `referenceLimitsFor(kind, model)`. Timed declarations require `1 <= minMs <= maxMs <= totalMs`; counts are positive integers except `image`, which may be zero. The UI and agents read limits from here, not from guides. `referenceImageLimitFor` stays as a fallback for adapters that do not implement the new hook. Only video declarations with `requiresHosting: true` depend on media hosting; local and vendor-inline models may omit it or set it false.
- `providers.list` gains `videoReferences: 'ready' | 'hosting_required'`, set to `ready` when hosting is configured with a secret. It never exposes hosting details. This readiness blocks video references only for models declaring `referenceInputs.video.requiresHosting: true`.
- `ProviderAdapter` create context gains `hosted: HostedInputs`.
- New error reasons listed in §4 and `generation.video_reference_hosting_required`, `hosting.not_configured`, `hosting.test_failed`, `hosting.upload_failed`, `hosting.store_failed`. The upload and store failure messages are generic and take no parameters. Video limit messages interpolate the model's limits from error params: count `max`, duration `minMs`/`maxMs`, total duration `totalMs`, size `maxBytes`, fps `minFps`/`maxFps`, and dimensions `minAspect`/`maxAspect`/`minPixels`/`maxPixels`. `hosting.test` returns `{ ok: true }` or `{ ok: false, step: 'upload' | 'read' | 'delete' | 'config', reason: 'hosting.not_configured' | 'hosting.test_failed' }`; its generic localized failure message needs no error params, and the settings UI displays the returned step separately.
- The `generation.submit` description and the `generation-inputs` guide drop "video inputs are rejected" and describe the model-specific limits and naming.

### 6. Seedance 2.5 registration

`ARK_MODEL_PARAMS['doubao-seedance-2-5']`: like `seedance2` but `resolution` 480p / 720p / 1080p (no 4k), `duration` 4–30 or -1, `generateAudio` default true, `returnLastFrame`, `executionExpiresAfter`; no `seed` or `cameraFixed`. `output_format: mov`, `draft` mode and `tools` are not exposed in this RFC. The model is added to the Ark known-models list so the settings page offers it.

### 7. UI

- The prompt panel's canvas-reference picker accepts video nodes when the chosen model's `referenceInputs.video` is set. A video reference shows its poster with a video badge and its duration; the panel shows the running total against the model limit and the first failing rule before submit.
- For a model with `referenceInputs.video.requiresHosting: true`, `videoReferences: 'hosting_required'` blocks submission and shows an inline note linking to Media hosting settings. The note disappears when hosting becomes ready. Models that omit `requiresHosting` or set it false, including the mock video model, stay usable without hosting.
- The cost line notes that a reference video adds its duration to the billed tokens. No price figure is shown (RFC 0029 §9 rule).

### 8. Other vendors (later steps, not built here)

| Vendor / model | Video input | Delivery | Uses this hosting? |
|---|---|---|---|
| Kling 3.0 Omni | `feature_video` ≤ 1 (3–15.5 s), `base_video` (edit) | URL only | Yes |
| Kling 4.0 | `feature_video` ≤ 5, 3–30 s each and total; `base_video` ≤ 1 | URL only | Yes |
| MiniMax H3 (all four) | `reference_video` ≤ 3, 2–15 s, ≤ 15 s total, ≤ 50 MB | URL, data URI (≤ 64 MB body), or `mm_file://` upload with the same API key, kept 7 days | Not needed: the vendor upload is simpler |
| Gemini Omni 1.2 (1.1 routes to it from 2026-12-03) | reference (≤ 3 × ≤ 3 s), edit, extend | Files API (48 h), inline ≤ 100 MB, external URL ≤ 15 MB | Not needed: Files API or inline |
| wan2.7-r2v | `reference_video`, 1–30 s, one character | Public URL | Yes |
| wan2.7-i2v | `first_clip` continuation | URL | Yes (an edit/extend step) |
| wan3.0-video / -prime | `reference_video` ≤ 5, ≤ 15 s total | URL | Yes |

MiniMax and Gemini could get video references without any hosting and are good next candidates. The research also found two adapter limits to correct separately: Kling 4.0 video files allow 300 MB (the adapter's 30 MB `inputBytes` is an image figure), and wan2.7-r2v reference videos are 1–30 s (2–10 s is its output range).

### 9. Acceptance and cost

- Unit and e2e tests use a fake TOS server that verifies the signature it receives, and the fake Ark server; no test reaches a real service.
- Two facts need a real run, with the maintainer's explicit approval, an isolated data directory, and the daily video limit set to 1: that Ark's video task endpoint reads a TOS presigned GET URL (Ark documents this only for chat), and how soon after submission it fetches it. One 4 s, 480p Seedance 2.0 mini task with one 3 s reference clip is enough. Until then the feature ships behind the hosting setting, and this section records the result.
- **Result (maintainer, 2026-11-11): passed.** A real Seedance video job with a TOS-hosted video reference succeeded, run by a tester on another device. So Ark's video task endpoint accepts a TOS presigned GET URL. How soon Ark fetches the reference was not measured, so the 6 h default task window is still a guess.

## Steps

Workers split by directory; the contract lands first.

- **a. Contract** (`packages/protocol`): hosting config and methods, `referenceInputs`, `videoReferences`, error reasons, method descriptions. Contract tests.
- **b. Hosting** (`services/studiod`, settings UI in `apps/web` / the provider settings package): credential-store entry, TOS signer, `HostedInputs`, `hosting.*` methods, `hosting.test`, settings section with disclosure. Fake TOS server.
- **c. Ark** (`packages/generation`): metadata fields in `submit.ts`, per-model limits, reference video items, URL lifetime, 2.5 task type, Seedance 2.5 registration, cleanup. Fake Ark tests.
- **d. Prompt panel and guides**: video references in the picker, limits and hosting note; `generation-inputs` guide; both READMEs and roadmap; AGENTS.md security rule; `docs/lessons` entries for anything non-obvious.
- **e. Acceptance** (§9), after approval.

## Implementation record (2026-11-10)

Steps a–d were built on separate branches split by directory, reviewed, and merged together. Decisions made during the build that refine the design above:

- **Hosting is declared per model.** `referenceInputs.video.requiresHosting` is set by Ark Seedance models and left unset by the local mock video model. The global `videoReferences` flag stays truthful (it only reports whether hosting is configured), and the prompt panel and agents apply it only to models that declare the need (§5, §7).
- **Upload object keys.** `url()` receives `` `${idempotencyKey}:${ordinal}` ``; the host splits at the last colon, hashes only the bare idempotency key and names the object `<prefix><sha256>/<ordinal>.<ext>`. `release()` takes the bare key, so cleanup needs no stored list.
- **Redaction is a host service.** `HostedInputs` gained `redact(text)`, which removes the access key id (including any `AKLT…`-shaped id from an earlier configuration), signatures and presigned URLs in virtual-hosted, path-style and internal host forms. Ark applies it to every vendor-derived error, including polls after a restart when the submit-time secrets are gone. Only the whole URL, `X-Tos-Signature` and `X-Tos-Credential` count as submit-time secrets; short public query values such as `X-Tos-Expires` do not, so a task id that happens to contain them is never rejected.
- **Order inside `submit`.** Every cheap local check (frame counts, the 64 MB body estimate without video bytes, the Ark API key) runs before the first upload. Each clip is uploaded once per `submit` call and its URL reused across POST retries. If an upload fails after earlier ones succeeded, the adapter releases the job's objects before throwing.
- **Failure mapping.** `hosting.not_configured` during upload is `rejected` with `generation.video_reference_hosting_required`. `hosting.upload_failed` and `hosting.store_failed` stay `transient` (a credential store can be locked briefly) and keep their own reasons. A link lifetime above `MAX_PRESIGN_SECONDS` (7 days) is rejected by Ark with `generation.invalid_params` before any upload; studiod never silently shortens a link.
- **Cleanup.** The runner also calls `cleanup` for jobs that settle `unknown`; adapters whose cleanup would delete paid output skip that case. Ark releases only when its submission record has `referenceVideos: true` and is not yet marked `released`, then writes `released: true`, so startup does not repeat releases for old jobs. The narrow upload-then-crash window is covered by the bucket lifecycle rule.
- **Uploads.** Files are streamed from disk with an explicit `Content-Length` and a signed SHA-256 payload hash, memoized by path, size, mtime, ctime and inode. There is no total timeout, only the caller's signal and a 60 s stall timeout, so a 200 MB clip on a slow link still completes.
- **Readiness.** The hosting manager caches the parsed `hosting.json` (studiod is its only writer; hand edits need a restart) and the secret's presence. A failed presence check is retried at most every 30 s. Every mutation re-reads the real state and refreshes the catalog, even on failure, without rebuilding adapters.
- **Count errors.** Image-count and total-input-count limits use `generation.invalid_params` with a detail; timed video and audio limits use their dedicated reasons with the model's limits as params, and the audio messages now interpolate them too.
- **Guide.** The repository's guide is `generation`, not `generation-inputs`. It may contain the literal vendor prompt identifiers `视频<n>`, `图片<n>`, `音频<n>` and their `@`-prefixed forms in backticks; the English-only guide test strips exactly those tokens.
- **Other adapters.** Kling 4.0's video `inputBytes` was corrected to 300 MB and the wan2.7-r2v reference duration comment to 1–30 s (§8). Neither accepts video input yet.

### Reference-label correction (2026-11-11)

`numberReferences` originally used one counter across all media types, and `submit` resolved every marker to a spaced label such as `视频 2`. That disagreed with §3 and the vendor tutorials: a preceding image advanced the first video's number, and 2.5 lost its documented `@` prefix. The UI used the same global counter, so changing only Ark's text would have left the author seeing a different number.

The shared helper now counts separately per media type, retaining input order, node deduplication and exclusion of text/empty media. Prompt chips and thumbnail badges use that helper unchanged. `ProviderAdapter.referenceLabelFor` optionally supplies model-specific syntax; known Seedance 2.0, Fast and Mini IDs resolve markers to unspaced identifiers, and 2.5 adds `@` for each media type. Date-suffixed IDs are normalized; unknown custom endpoint IDs and other providers retain their legacy label format. Handwritten text and original stored markers remain intact. Ark serializes images, then videos, then audio, preserving order within each type, so interleaving types in submission inputs cannot change their labels.

Fake-Ark HTTP tests cover an image and two videos in interleaved input order for all four registered Seedance variants, asserting exact text and media order together. Contract and chip tests cover per-type counters; a browser test checks mixed image/video chips, reordering and the submitted label. No real generation or hosting calls were made. The other external adapters reviewed for this correction accept image references only; their existing label spelling is outside this Seedance correction and is not assumed to be vendor syntax.

Verified on fakes only: a fake TOS server that checks every signature and the fake Ark server, including a studiod-level flow (upload, signed GET by the vendor, settle, release) that asserts no presigned URL reaches job rows, events, errors, submission records or logs. The signer passes Volcengine's published header and query vectors. Windows PasswordVault writes were checked by hand on 2026-11-10 with the `vis-creative.hosting.test` entry: set, read back, overwrite and delete all behave as on fakes. macOS Keychain passed on 2026-11-11 through the real `createKeychainSecretStore` and `/usr/bin/security`, with the `vis-creative.hosting.test` service and `tos` account only: absent before, set, read back, overwrite with spaces, quotes, a backslash and `$`, delete, absent after, and a harmless repeat delete; no entry was left behind. Not yet verified: the §9 paid run.

## Appendix: sources (checked 2026-11-10)

- Ark create video task: https://docs.volcengine.com/docs/ark/create-video-generation-task-api?lang=zh
- Seedance 2.0 / 2.5 tutorials: https://ark.volcengine.com/region:cn-beijing/docs/seedance-2-0, https://ark.volcengine.com/region:cn-beijing/docs/seedance-2-5
- Ark pricing: https://ark.volcengine.com/region:cn-beijing/docs/model-pricing
- Ark reading TOS presigned URLs: https://docs.volcengine.com/docs/82379/2551760?lang=zh
- Kling Omni: https://kling.ai/document-api/api/video/3-0-omni/video-omni, https://kling.ai/document-api/api/video/4-0/video-omni
- MiniMax: https://platform.minimax.io/docs/api-reference/video-generation-v2-create.md, https://platform.minimax.io/docs/api-reference/file-management-upload.md
- Gemini Omni: https://aistudio.google.com/docs/omni, https://aistudio.google.com/docs/file-input-methods
- Wan: https://www.alibabacloud.com/help/en/model-studio/wan-video-to-video-api-reference, https://www.alibabacloud.com/help/en/model-studio/wan3-video-generation-api-reference, https://www.alibabacloud.com/help/en/model-studio/image-to-video-general-api-reference
