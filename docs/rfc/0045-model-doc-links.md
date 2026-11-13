# RFC 0045: Model documentation links

Status: implemented (2026-11-11). Direction set by the maintainer on 2026-11-10. Extends [RFC 0028](0028-agent-and-provider-registries.md) (provider type descriptors) and [RFC 0026](0026-agent-instructions.md) (guides).

## Background

Each generation model has its own prompting conventions: how a video model reads camera language, how many subjects an image model keeps straight, which reference syntax it expects. Vendors publish these in prompt guides and API references, and revise them often. Agents today only see a model's ID, label, parameter schema and reference limits in `providers.list`, so they write prompts from memory, which is usually older than the model.

Two ways to close the gap were rejected:

- **Copying vendor guides into the repository** (as guide text or a bundled skill). The text goes stale as vendors revise it, keeping it current needs a sync task, and copying vendor documentation into a public repository raises copyright questions.
- **Hard-coding model advice in the generation guide.** Same staleness, and it puts built-in creative defaults where the author's own skills should win.

## Goals

- Every built-in known model carries links to its vendor's official pages: a prompt guide when one exists, and the API reference.
- Agents see the links where they already look, on the model in `providers.list`, and open them before writing the first prompt for that model in a session.
- Nothing to keep in sync: the repository holds URLs, and Agents read the current page.

## Out of scope

- Copying, caching or summarizing vendor pages. At most a short note in our own words may sit next to a link later; none ships now.
- Author-editable links for custom models in `providers.json`. Authors who want their own prompting rules write a skill (RFC 0033), which already outranks built-in guidance.
- Showing the links in the settings UI. They are Agent-facing for now; a "Docs" link on model chips is a possible follow-up.
- A link checker in CI. Links are checked by hand when a model is added or rechecked, as model parameters already are.

## Product principle check

- **Mechanism, not taste.** The product ships pointers to the vendor's own documentation; it encodes no opinion about what a good prompt is. Vendor advice is craft input for the Agent.
- **Author outranks vendor.** The generation guide says the author's direction and their skills outrank vendor advice, so a skill can override a vendor convention.
- **No hidden inference.** Nothing is learned or stored about the author.

## Design

### Contract (`packages/protocol/src/providers.ts`)

```ts
ModelDocLink = { kind: 'prompt_guide' | 'api_reference', url: string }   // https, public domain names only
```

- `ProviderTypeDescriptor.knownModels[].docs?: ModelDocLink[]` (at most 6).
- `ProviderTypeDescriptor.modelDocs?: Partial<Record<MediaKind, ModelDocLink[]>>`: pages that cover a whole family for a media kind, used for IDs outside `knownModels`, such as Ark endpoint IDs.
- `providers.list` → `providers[].models[].docs?`: the known model's own links if it has any, else the type's `modelDocs` for the model's media kind, else absent. Unavailable services still list them. Built-in mock and render models have none.

URLs must be HTTPS with a domain name: no HTTP, IP literals, `localhost` or other schemes. Unknown fields are rejected, so vendor text cannot ride along in a link.

### Agent guidance

The `generation` guide gains a "Model documentation" section: before the first prompt for a model in a session, open its prompt guide (or its API reference when no guide is listed) and prefer the current page over memory; fallback links are general and may not match the exact model; if a page cannot be opened, say so and continue with general craft rather than guess model-specific syntax; the author's direction and skills outrank vendor advice; apply what fits in your own words without pasting vendor text into nodes or replies. The core instructions are unchanged, keeping the always-loaded text within its budget.

> Revised by [RFC 0048](0048-agent-native-capabilities.md) (2026-11-12): a Codex session reported a reachable page as unavailable without trying. The guide now says how to read a page (the Agent's web tool or `curl -sL`, trying the other on failure), notes that vendor pages may show a JavaScript notice and still carry their text, and allows calling a page unavailable only after trying, naming the URL and what failed.

Agents fetch pages with their own browsing ability. A session without network (the read-only isolation fallback) cannot, and the guide covers that case.

### Contributors

`docs/contributing/adding-a-provider.md` asks for `docs` on every known model, checked by hand on the vendor's own domain, and for `modelDocs` only with family-wide pages. A unit test fails when a built-in known model has no link.

## Links shipped

Checked 2026-11-11 by fetching each page over HTTPS without running JavaScript, by a Codex worker and spot checks. The links live in each type's `type.ts`.

| Service | Models | Prompt guide | API reference |
| --- | --- | --- | --- |
| Ark | Seedance 2.0, 2.0 fast, 2.0 mini | `docs/ark/seedance-2-0-prompt-guide` (Chinese) | `docs/ark/create-video-generation-task-api` |
| Ark | Seedance 2.5 | `docs/ark/seedance-2-5-prompt-guide` (Chinese) | same |
| Ark fallback | other video IDs (endpoints) | none: guides are per version | same |
| Ark fallback | image IDs (Seedream) | `docs/ark/seedream-4-0-5-0-prompt-guide`, which covers 4.0, 4.5 and 5.0 lite, not 5.0 pro or flash | `docs/ark/image-generation-api` |
| Kling | VIDEO 3.0, 3.0 Omni, 4.0 | the model guides under `kling.ai/quickstart/` | none: the API pages render only with JavaScript |
| Kling | IMAGE 3.0 Omni | none found | `document-api/api/image/3-0-omni/image-omni`, readable only in a browser |
| OpenAI | GPT Image 2.5 and 2 | `guides/image-prompting`, at the model's section | `reference/resources/images/methods/generate` |
| DashScope | wan2.7 t2v, i2v, r2v | `text-to-video-prompt` (covers Wan 2.2–3.0) | the matching text-, image- or reference-to-video reference |
| DashScope | wan3.0-video, -prime | `wan3-video-generation-prompt-guide` | `wan3-video-generation-api-reference` |
| DashScope | wan2.7-image, -pro | `text-to-image-prompt` | `wan-image-generation-and-editing-api-reference` |
| MiniMax | H3 family | `guides/video-prompt`, an example gallery rather than a writing manual | `video-generation-v2-create.md` |
| MiniMax | image-01 | none: the image guide may describe another model | `image-generation-t2i.md` |
| Gemini | Nano Banana models | `aistudio.google.com/docs/image-generation#prompt-guide` | `api-reference/generate-content` |
| Gemini | gemini-omni-1.1-flash | `docs/omni#prompt-guide`, written for 1.2 | none checked |

Observations from the check, outside this RFC:

- Google's Omni page says requests to `gemini-omni-1.1-flash` route to `gemini-omni-1.2-flash` from 2026-12-03. The Gemini adapter should add 1.2 before then.
- `ai.google.dev` and `www.volcengine.com/docs/82379/...` URLs redirect; the links use the targets.

## Decisions

- Links only, no copied vendor text and no sync automation (maintainer, 2026-11-10).
- Two link kinds, `prompt_guide` and `api_reference`. Pages such as model overviews or pricing are left out until an Agent needs them.
- A per-kind type fallback rather than per-family pattern matching on IDs: custom endpoint IDs say nothing reliable about the model behind them, so the fallback carries only family-wide pages.
