export const generation = `
# Generation jobs and references

Read providers_list before generating to discover available providers, model IDs, media types, parameter descriptions and defaults. gen_submit normally omits provider and model to use the configured defaults; when specifying them, use discovered IDs. Retain the user's selected node generation model and parameters unless asked to change them; canvas_apply node.setGeneration stores those preferences. For exact charts, typography and motion graphics, read the code-render guide.

## References and operations

Reference a node's media in a prompt as {{ref:<nodeId>}}. Include that node's media slot in generation.submit.inputs. The server converts markers into image/video/audio numbers in this submission's input order. Check that the selected model supports each reference media type, including audio.

For generation operations such as upscale, inspect the model's operations through providers.list first. The first input is the subject node's main asset; the result is created beside that subject by default. Generation inputs are slot references: include prompt-source, storyboard and code-text slots as well as media references. Canvas node provenance inputs instead contain node IDs (see the canvas guide). An input may also be { assetVersionId }, a pinned asset version of this project such as a setting's reference image; for shot-linked targets the server appends the shot's setting and style references itself (see the library guide).

## Waiting and recovery

Image, video and audio generation is asynchronous. After gen_submit, use gen_get with waitMs; it returns on each status change until succeeded, failed, unknown or cancelled. Successful output fills the canvas automatically. succeeded with missingOutputIndexes means some requested outputs were not produced; tell the user which are missing.

The core cost guardrails apply throughout. quota_exceeded is a stop: the user can raise the Agent daily limit in settings. unknown can mean the external service accepted a job; report uncertainty and stop automatic submission. When recheckable is true, generation.recheck queries that original job. For a timeout or disconnect, retry with the same returned requestId to retrieve the first receipt. For rejected parameters, use the error to correct them instead of repeated probing.

Cancel with gen_cancel. Cancellation does not imply a refund: providerCancelled: false means the external service may still charge. For script batches, read the script guide for plan/start, approval and per-session cancellation rules.
`.trim()
