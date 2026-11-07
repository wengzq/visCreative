# Adding a generation provider

A provider adapter turns generation requests into vendor tasks and validated output bytes. Read [AGENTS.md](../../AGENTS.md), [RFC 0028 §2](../rfc/0028-agent-and-provider-registries.md#2-provider-type-registry) and the [paid-call design in RFC 0007](../rfc/0007-generation-providers.md) first. This guide uses local fake servers only.

## 1. Prepare and choose the API shape

Use Node 24 or newer, ffmpeg on `PATH`, and workspace dependencies installed from the repository root:

```sh
npx --yes pnpm@10.34.9 install
```

Create `packages/generation/src/providers/<name>/`, normally with `index.ts` (adapter), `type.ts` (descriptor), model/parameter definitions and a fake server under `testing/`. Implement `ProviderAdapter` from `packages/generation/src/providers/types.ts`. Choose a reference for each distinct API shape, not just each vendor:

| Shape | Reference | Lost submit |
| --- | --- | --- |
| Asynchronous, queryable by a client id | `providers/kling/index.ts` | Persist intent and client id before create; recover through `findTaskByIdempotencyKey` |
| Asynchronous, no client-id recovery | `providers/dashscope/index.ts` | Persist intent before create; leave an ambiguous result unknown, including after restart |
| Synchronous output | `providers/openai/index.ts` and `providers/sync.ts` | Use `stageSyncOutput`; a timeout cannot be recovered by submitting again |

These paths are relative to `packages/generation/src/`. MiniMax and Gemini each combine asynchronous video with synchronous images; test both shapes. Check the vendor documentation for supported models, inputs, endpoints, latency and status semantics, and cite it beside the model table. Discuss new dependencies before adding any.

## 2. Declare the type and register it

`ProviderType` is defined in `packages/generation/src/providers/registry.ts`. Read `providers/openai/type.ts` and `providers/kling/type.ts` as complete examples. OpenAI's descriptor ends with:

```ts
  verified: false,
  create: (config, deps) => createOpenAIProvider({ ...config, ...deps }),
```

The factory signature is:

```ts
create(config: ProviderEntry, deps: { getKey(): Promise<string | undefined>; dataDir: string; media: MediaTools }): ProviderAdapter
```

Declare these fields:

| Field | What to supply |
| --- | --- |
| `type`, `label` | Stable `[a-z][a-z0-9-]*` type id and Chinese/English display names. `mock` and `render` are reserved. A configured service's `id` is separate from its type. |
| `needsKey`, `kinds` | Whether credentials are required, and supported media kinds. |
| `regions` | Region ids, bilingual labels and exact base URLs. Account/key region restrictions belong in help text too. |
| `endpoints` | Every API path as `{ id, label, path }`, resolved through `providerPaths`. With a custom URL users set their own, and an unset path means the base URL itself. Keep query parameters in the adapter, use `{model}` and `{id}` for path variables, and set `requiredFor` on paths a paid job cannot finish without. |
| `allowCustomBaseUrl` | Set `true` for compatible gateways and dedicated hosts, with a clear notice that the key goes to the chosen host, as OpenAI does. It is not a workaround for missing region support. |
| `knownModels` | Suggested ids, kinds and labels. Users may enter other ids; the adapter must validate what it can actually run. |
| `settingsSchema`, `settingsFields` | Optional zod schema for non-secret settings and bilingual labels/descriptions for its properties. JSON Schema title/description is the fallback. The generic form supports flat string, number/integer, boolean and enum fields. |
| `help` | `consoleUrl`, bilingual key instructions and optional model-id instructions. |
| `availability` | Optional bilingual regional/service limitations; informational, not an access check. |
| `verified` | `false` until maintainer-approved real-API acceptance passes. |
| `create` | Construct the adapter from parsed config, key getter, private data directory and media tools. |

Import the descriptor and add it to `builtinProviderTypes` in `packages/generation/src/providers/registry.ts`. This list currently includes Ark, Kling, OpenAI, DashScope, MiniMax and Gemini; the earlier RFC note saying “Ark only” describes step b, not the current list. Export a constructor/descriptor through `packages/generation/src/index.ts` if callers need it. Tests and embedders may instead supply `StudiodOptions.providerTypes`; this **replaces** the default list, so include `...builtinProviderTypes` if those types should remain available.

There are no new protocol enums or UI service lists to edit. `services/studiod/src/providers.ts` validates settings, kinds and region/URL agreement on save, load and pinned-job restore; `provider-config.ts` reads and writes the config file. Every new service config needs an explicit `baseUrl`; only legacy Ark entries may omit it. The shared URL rule requires HTTPS (HTTP only for `localhost` or `127.0.0.1`), with no userinfo, query or fragment. Enforce the adapter's own allowed-host policy too. In particular, do not synthesize arbitrary credential destinations from settings; see the [deferred DashScope workspace hosts](../rfc/0028-agent-and-provider-registries.md#implementation-notes-step-c-second-wave-dashscope-minimax-and-gemini-2026-11-04).

## 3. Preserve paid-call intent

`submit(request, { idempotencyKey, signal? })` must return the same external task for repeated or concurrent keys without another paid create. Persist and flush intent **before** calling, then durably record the accepted task id. Keep this effective across adapter instances and process restarts. The runner records an Attempt too; it does not replace the adapter's durable intent.

Follow Kling's persistence and reconciliation if the vendor supports lookup by client id. Only implement `findTaskByIdempotencyKey` when it really finds the original task: an intent plus an empty lookup does not authorize another create. Kling releases a definite rejection only after lookup confirms absence. Without recovery, follow DashScope's durable submitting/accepted records and omit the method. Transport loss, malformed success, an ambiguous server failure or an interrupted submit must retain intent and become `ProviderError('timeout', ...)`; never relabel them as retryable.

For synchronous APIs, `stageSyncOutput` supplies `submit`, `getTask`, `download` and `cleanup`. Supply `dataDir`, `providerId`, `maxBytes`, allowed `mimeTypes`, and `call(request, options)`. The callback returns decoded `DownloadedOutput[]`, or a completed failure:

```ts
{ state: 'failed', error: { code: string; message: string; reason?: string } }
```

The helper durably claims intent, deduplicates calls, stages bytes under `dataDir/generation-sync/` and returns a synthetic task id. Forward all four methods; cleanup runs after durable terminal settlement and keeps a permanent tombstone. Unknown jobs retain staging. A completed but unusable result becomes `failed` with `sync_output_invalid`; staging uncertainty stays unknown. Validate the key before entering staging, use a timeout longer than documented latency (OpenAI currently uses five minutes), and do not add a pretend recovery or cancel method.

## 4. Map statuses, errors and cancellation

`getTask(externalTaskId, { signal? })` returns `pending`, `running`, `succeeded` with indexed output refs, `failed` with a safe error, or `cancelled`. Preserve enough information in task ids to route polling after restart; mixed adapters use prefixes such as `video:` and `image:`. Expired/missing remote tasks are `ProviderError('not_found', ...)`: DashScope's `UNKNOWN` means unknown locally, not a failed task safe to regenerate.

`ProviderError` takes `(kind, message, reason?, params?)`. Use English fallback messages and safe string/number params:

| Kind | Meaning |
| --- | --- |
| `rejected` | Definite refusal or invalid request; no uncertain accepted work. During submit the runner settles the job as `failed` with `provider_rejected`. |
| `transient` | Proven no effect and retryable. During submit this permits another call with the same key; use only when that is safe. |
| `timeout` | Outcome uncertain. The runner queries recovery if supported, otherwise settles `unknown` with `submit_unconfirmed`. |
| `not_found` | Task/output missing or expired; never permission for another paid create. |

Map HTTP status and vendor codes deliberately; do not rely on every error body being JSON. Add localized reasons in **both dictionaries** in `packages/ui-kit/src/error-messages.ts`, reusing `generation.provider_auth_failed`, `generation.provider_balance`, `generation.moderation_rejected` and other existing reasons where appropriate. Submit rejection reasons flow into job `error.data.reason`. Existing asynchronous adapters also return `error.data.reason` for some completed failures, but the `ProviderTaskState` failed arm currently types only `code` and `message`; keep that typing gap visible when extending it. Synchronous completed failures have explicit `reason` support in `stageSyncOutput`.

Moderation follows timing, not just a vendor error code. A block at create before acceptance is `rejected` with `generation.moderation_rejected`. A block discovered after acceptance is a completed `failed` task, with the same reason and a message that makes no billing claim. For an unclear stage, preserve uncertainty about billing. See OpenAI's moderation-stage tests and DashScope/Gemini's post-acceptance safety tests; do not throw a pre-acceptance rejection for an already-generated output.

Implement optional `cancel` only if `{ cancelled: true }` means the vendor confirmed that work stopped. An acknowledgement alone is insufficient: Gemini checks a later `cancelled` read. Omit `cancel` when there is no safe API. MiniMax is the important example: its DELETE can cancel a queued task **or delete a finished paid output**, and a state check cannot close that race. Its adapter exposes no cancel; local cancellation reports `providerCancelled: false`, and generation/billing may continue. Cancellation never promises a refund.

Set optional `pollIntervalMs` to the vendor's recommended delay (DashScope uses `15_000`). The runner uses it for pending, running and concurrency-limit waits; retry backoff is separate.

## 5. Validate outputs and contain credentials

Download promptly when a task succeeds. Use `boundedBody(response, maxBytes)` from `providers/download.ts` to bound streaming responses even without `Content-Length`. Bound JSON/base64 envelopes before decoding too. Check allowed MIME types, magic bytes and dimensions/duration with the existing media helpers; neither response headers nor a requested format establish the bytes' format. Asset blobs have no extension: use `input.mime` and an appropriately named temporary copy when probing, as Kling does.

Validate output URL syntax; reject userinfo and URLs containing the provider API key. Never forward the API key or `Authorization` header to another host or across a redirect. Kling downloads without auth and uses `redirect: 'error'`. Gemini's authenticated file download first requires the exact API origin and a fixed file path, then sends `x-goog-api-key`. Test malicious hosts, paths and redirects. Refresh expiring URLs by querying the existing task (MiniMax), never by recreating it; missing output stays unknown.

Retrieve keys only through `deps.getKey()`. Production storage is macOS Keychain or Windows Credential Manager (`vis-creative.provider`, account/provider id); keys never belong in settings, `providers.json`, SQLite, URLs, process arguments, logs, events, errors or Agent-visible output. Validate missing/unreadable keys and header newlines before intent or network activity. Catch raw fetch/credential-store exceptions, redact vendor diagnostics with `providers/http.ts` helpers, and reject task ids/output refs that echo the key. Tests use injected fake getters or `createMemorySecretStore`; never read real credentials. System-store tests may use only `vis-creative.provider.test` and must delete fake entries in `finally`.

## 6. Exercise the fake server and contract

Start with `packages/generation/src/providers/testing/example.ts` and `example.test.ts`: a local server, fake key, descriptor and `providerContract` factory. This is a registry/contract teaching fixture, **not** production persistence or media validation: it relies on the fake server's idempotency and checks only a small PNG response. Copy the appropriate paid adapter's intent and validation patterns for production.

For a throwaway rehearsal, copy `example.test.ts` beside itself under another `.test.ts` name, change the contract's display name and use a fresh configured service id. Run it, then register the example descriptor through a test-only `providerTypes` option and check catalog/settings behavior as in `services/studiod/src/providers-registry.test.ts`. Remove the throwaway test afterward.

For the actual adapter, import `providerContract` directly from `providers/contract.ts` (it is test-only, not a package export). Its factory receives `normal`, `lost`, `cancel-confirmed`, `cancel-unconfirmed`, `wrong-mime`, `oversized`, `moderation` or `secret-error` and returns a fresh `ProviderContractHarness`: `adapter`, `request`, `secret`, `creates()`, `recoversLost`, unsafe-download `output`, and `close()`. `creates()` counts accepted external creates, not calls to the adapter. Close fake servers and remove temporary data in cleanup.

Run **one harness per API shape**. Kling's test registers these two:

```ts
providerContract('Kling video', scenario => fakeKling(scenario, 'video'))
providerContract('Kling image', scenario => fakeKling(scenario, 'image'))
```

MiniMax and Gemini likewise test staged images separately from asynchronous video. The suite checks duplicate/concurrent keys, runner recovery without a second create, honest cancel, unsafe downloads, create-time moderation and fake-key leaks in errors, logs, events and stored jobs. Add adapter tests for restart/concurrency, post-acceptance moderation, transport/status mapping, input/output validation, URL expiry and credential destinations. For synchronous unsafe-download scenarios, OpenAI's harness deliberately corrupts staged output; a completed bad create is tested separately as `sync_output_invalid`.

Run from the repository root:

```sh
npx --yes pnpm@10.34.9 exec vitest run packages/generation/src/providers/testing/example.test.ts services/studiod/src/providers-registry.test.ts
npx --yes pnpm@10.34.9 exec vitest run packages/generation/src/providers/kling/kling-provider.test.ts packages/generation/src/providers/dashscope/dashscope-provider.test.ts packages/generation/src/providers/openai/openai-provider.test.ts
npx --yes pnpm@10.34.9 check
```

Replace/add the focused path with your adapter's `.test.ts`. For code changes, also run `build` and the full `--filter @vis/web test:e2e` suite twice, as required by AGENTS.md; these use fake servers and a fake Agent. The settings fixture is `apps/web/e2e/providers.e2e.ts`.

Update RFC 0028 and both README roadmaps with supported features and remaining uncertainties. Keep `verified: false`: fake tests are enough to propose a merge, not to claim real acceptance. Real vendor or Agent calls require the maintainer's explicit approval, isolated data and tightened daily limits; never call them as part of tests or development. Commit the adapter, registration, tests, reason dictionaries and documentation together, with the required attribution trailer.
