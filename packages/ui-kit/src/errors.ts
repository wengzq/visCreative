import { codes, reasons, type Params } from './error-messages'
import { messagesFor, type Locale } from './i18n'

const cjk = /[㐀-鿿]/

// These older result fields carry only text. Keep the mapping here until their contracts carry reason/params.
const textReasons: Record<string, string> = {
  'dsh was not found; run npx @deepseek-ai/dsh once, or set VIS_DSH_PATH': 'session.dsh_not_found',
  'Codex runtime is closed': 'session.codex_runtime_closed',
  'This session already has an active turn': 'session.active_turn_exists',
  'DeepSeek Harness runtime is closed': 'session.dsh_runtime_closed',
  'Runtime is closed': 'session.runtime_closed',
  'Claude exited before starting': 'session.claude_exited_before_start',
  'Ark returned an invalid output URL': 'generation.ark_output_url_invalid',
  'SVG cannot be used as an Ark reference image; export it as PNG first': 'generation.svg_reference_unsupported',
  'The selected model does not yet support audio generation; use Mock music or Mock sound effects': 'generation.audio_generation_unsupported',
  'The selected model does not yet support audio references': 'generation.audio_reference_unsupported',
  'Audio references only support WAV or MP3': 'generation.audio_reference_format',
  'Audio references allow at most 3 clips': 'generation.audio_reference_count',
  'Each audio reference must be 2-15 seconds long': 'generation.audio_reference_duration',
  'Audio reference total duration cannot exceed 15 seconds': 'generation.audio_reference_total_duration',
  'Audio references also require at least one reference image': 'generation.audio_reference_image_required',
  'Audio references cannot be combined with first-frame or first-and-last-frame modes; use auto or reference-image mode': 'generation.audio_reference_mode',
  'Invalid idempotency key': 'generation.idempotency_key_invalid',
  'Ark submission record cannot be confirmed; not resubmitted': 'generation.ark_submission_record_unknown',
  'Ark submission result is unknown; not resubmitted': 'generation.ark_submission_unknown',
  'Ark responded but saving the submission record failed; not resubmitted': 'generation.ark_submission_save_failed',
  'Cannot read Ark API Key': 'generation.ark_key_unreadable',
  'Configure Ark API Key first': 'generation.ark_key_required',
  'Ark query temporarily failed': 'generation.ark_query_failed',
  'Ark response format cannot be confirmed': 'generation.ark_response_invalid',
  'Ark supports only local image inputs; video inputs are not yet supported': 'generation.ark_input_kind_unsupported',
  'Total Ark input image size cannot exceed 10 MiB': 'generation.ark_input_size_limit',
  'Cannot read Ark input image': 'generation.ark_input_unreadable',
  'Each audio reference size cannot exceed 15 MB': 'generation.ark_audio_size_limit',
  'Cannot read audio reference duration': 'generation.ark_audio_duration_unreadable',
  'Cannot read audio reference': 'generation.ark_audio_unreadable',
  'Ark media type does not match the model': 'generation.ark_model_kind_mismatch',
  'Ark requires a generation prompt': 'generation.ark_prompt_required',
  'Too many Ark input images: at most 10 for image generation and 9 for video': 'generation.ark_image_count_limit',
  'First-frame mode requires exactly one image': 'generation.ark_first_frame_count',
  'First-and-last-frame mode requires exactly two images': 'generation.ark_first_last_count',
  'Reference-image mode requires image inputs': 'generation.ark_reference_required',
  'Ark request body size cannot exceed 64 MB': 'generation.ark_request_size_limit',
  'Cannot save Ark submission record; request not submitted': 'generation.ark_submission_not_saved',
  'Ark image results contain sensitive information; output URLs not saved': 'generation.ark_image_output_sensitive',
  'Ark image results cannot be confirmed; not resubmitted': 'generation.ark_image_output_unknown',
  'Ark video job ID cannot be confirmed; not resubmitted': 'generation.ark_video_id_unknown',
  'Ark video job ID contains sensitive information; not saved': 'generation.ark_video_id_sensitive',
  'Ark image job does not exist': 'generation.ark_image_not_found',
  'Ark video output URL contains sensitive information; not saved': 'generation.ark_video_url_sensitive',
  'Ark video job status cannot be confirmed': 'generation.ark_video_state_unknown',
  'Invalid output index': 'generation.output_index_invalid',
  'Output index out of range': 'generation.output_index_invalid_range',
  'Invalid Ark output type': 'generation.ark_output_type_invalid',
  'Ark output download temporarily failed': 'generation.ark_download_failed',
  'Cannot read Ark video metadata': 'generation.ark_video_metadata_unreadable',
  'Job does not exist': 'generation.mock_job_not_found',
  'Media type does not match the model': 'generation.mock_model_kind_mismatch',
  'Job accepted but response lost': 'generation.mock_response_lost',
  'Simulated temporary query failure': 'generation.mock_query_failed',
  'Job cancelled': 'generation.mock_job_cancelled',
  'Job has no downloadable outputs yet': 'generation.mock_outputs_unavailable',
  'Simulated temporary download failure': 'generation.mock_download_failed',
  'Cannot find Chrome for rendering; install Google Chrome': 'generation.render_browser_missing',
  'This ffmpeg lacks libvpx-vp9; transparent WebM rendering is unavailable': 'generation.render_alpha_encoder_missing',
  'This ffmpeg lacks prores_ks; MOV ProRes 4444 export is unavailable': 'media.prores_encoder_missing',
  'The MOV export is unavailable or has expired; export it again': 'media.export_expired',
  'inputs requires a text slot containing HTML': 'generation.render_input_required',
  'Render job does not exist (possibly restarted during rendering)': 'generation.render_job_not_found',
  'Render job cancelled': 'generation.render_job_cancelled',
  'Render output does not exist': 'generation.render_output_not_found',
  'Enter an absolute path': 'fs.absolute_path_required',
  'Directory does not exist or is not readable and writable': 'fs.directory_unavailable',
  'Project directory has moved or is inaccessible': 'space.directory_unavailable',
  'Permanent deletion is not complete; try again': 'space.purge_incomplete',
  'Cannot delete the filesystem root, user home directory or projects root directory': 'space.purge_protected_root',
  'Project directory contains the application data directory': 'space.purge_contains_data',
  'Project directory contains another project directory or application data': 'space.purge_contains_project',
  'Application data directory contains another project directory and cannot be permanently deleted': 'space.purge_data_contains_project',
  'Cannot confirm submission result; not resubmitted to avoid duplicate generation': 'generation.submit_unconfirmed',
  'Generation service cannot find this job': 'generation.external_task_missing',
  'Generation service cannot find this job; outputs cannot be downloaded': 'generation.external_output_missing',
  'Simulated generation failure': 'generation.mock_failed',
  'Ark returned no usable images': 'generation.ark_no_output',
  'Ark video generation timed out': 'generation.ark_expired',
  'Ark video job cancelled': 'generation.ark_cancelled',
  'Ark video generation failed': 'generation.ark_failed',
}

const textPatterns: { pattern: RegExp; reason: string; params: string[] }[] = [
  { pattern: /^(.+) Agent is not configured$/, reason: 'session.agent_unconfigured', params: ['kind'] },
  { pattern: /^Cannot start Codex: (.+)$/, reason: 'session.codex_start_unavailable', params: ['detail'] },
  { pattern: /^Waiting for Codex startup exceeded (.+) seconds$/, reason: 'session.codex_start_timeout', params: ['seconds'] },
  { pattern: /^Codex startup failed: (.+)$/, reason: 'session.codex_start_failed', params: ['detail'] },
  { pattern: /^Cannot start DeepSeek Harness: (.+)$/, reason: 'session.dsh_start_unavailable', params: ['detail'] },
  { pattern: /^Waiting for DeepSeek Harness startup exceeded (.+) seconds$/, reason: 'session.dsh_start_timeout', params: ['seconds'] },
  { pattern: /^DeepSeek Harness startup failed: (.+)$/, reason: 'session.dsh_start_failed', params: ['detail'] },
  { pattern: /^DeepSeek Harness rejected this message: (.+)$/, reason: 'session.dsh_dispatch_rejected', params: ['detail'] },
  { pattern: /^DeepSeek Harness exited while processing the message: (.+)$/, reason: 'session.dsh_dispatch_unknown', params: ['detail'] },
  { pattern: /^Cannot start Claude: (.+)$/, reason: 'session.claude_start_unavailable', params: ['detail'] },
  { pattern: /^Waiting for Claude startup exceeded (.+) seconds$/, reason: 'session.claude_start_timeout', params: ['seconds'] },
  { pattern: /^Claude startup failed: (.+)$/, reason: 'session.claude_start_failed', params: ['detail'] },
  { pattern: /^Invalid Ark generation parameters: (.*)$/, reason: 'generation.ark_params_invalid', params: ['detail'] },
  { pattern: /^Ark output download failed \(HTTP (\d+)\)$/, reason: 'generation.ark_output_http_failed', params: ['status'] },
  { pattern: /^Ark request failed \(HTTP (\d+)\)$/, reason: 'generation.ark_http_failed', params: ['status'] },
  { pattern: /^Generation service (.+) configuration is invalid; cannot confirm the job result$/, reason: 'generation.job_provider_config_invalid', params: ['providerId'] },
  { pattern: /^Generation service (.+) is unavailable; cannot confirm the job result$/, reason: 'generation.job_provider_missing', params: ['providerId'] },
  { pattern: /^Generation service returned (.+), inconsistent with the completed record$/, reason: 'generation.external_state_changed', params: ['state'] },
  { pattern: /^Render library "(.+)" is missing or unavailable\. Add the library to the render-libs folder and retry$/, reason: 'render.lib_missing', params: ['name'] },
  { pattern: /^Render library "(.+)" cannot be provided\. Author libraries must be single \.js files that do not use a built-in library name$/, reason: 'render.lib_name_refused', params: ['name'] },
  { pattern: /^Page did not define window\.vis = \{ duration, seek\(t\) \} within (.+) seconds$/, reason: 'generation.render_api_missing', params: ['seconds'] },
  { pattern: /^Invalid duration: window\.vis\.duration must be a number from 0 to (.+) seconds; got (.+)$/, reason: 'generation.render_duration_invalid', params: ['maxSeconds', 'duration'] },
  { pattern: /^Found ffmpeg (.+)\. Timeline export requires ffmpeg (\d+) or newer\. Update ffmpeg (?:and restart visCreative )?to export\.$/, reason: 'media.ffmpeg_version_unsupported', params: ['version', 'required'] },
  { pattern: /^Cannot find (.+); install ffmpeg first$/, reason: 'generation.render_tool_missing', params: ['tool'] },
  { pattern: /^ffmpeg encoding failed: (.*)$/, reason: 'generation.render_encoding_failed', params: ['detail'] },
  { pattern: /^Error at frame (\d+) \((.+) seconds\)$/, reason: 'generation.render_frame_failed', params: ['frame', 'seconds'] },
]

function translateText(message: string, locale: Locale): string {
  const dictionary = messagesFor(reasons, locale) as Record<string, (p: Params) => string>
  const reason = textReasons[message]
  if (reason) return dictionary[reason]!({})
  for (const entry of textPatterns) {
    const match = entry.pattern.exec(message)
    if (match) {
      const params = Object.fromEntries(entry.params.map((name, index) => [name, match[index + 1]!]))
      if (params.detail) params.detail = translateText(params.detail, locale)
      return dictionary[entry.reason]!(params)
    }
  }
  return message
}

/** Converts an RPC error or arbitrary exception into a sentence in the current language */
export function describeError(error: unknown, locale: Locale): string {
  const e = error as { message?: unknown; code?: unknown; data?: { code?: unknown; reason?: unknown; params?: unknown } } | null
  const message = typeof e?.message === 'string' ? e.message : String(error)
  const reason = typeof e?.data?.reason === 'string' ? e.data.reason : undefined
  const params = (e?.data?.params && typeof e.data.params === 'object' ? e.data.params : {}) as Params
  const translate = reason ? (messagesFor(reasons, locale) as Record<string, ((p: Params) => string) | undefined>)[reason] : undefined
  if (translate) return translate(typeof params.detail === 'string' ? { ...params, detail: params.detail.split('\n').map(line => translateText(line, locale)).join('\n') } : params)
  // Render diagnostics may follow the app's failure sentence on separate lines; preserve those diagnostics.
  const localized = message.split('\n').map(line => translateText(line, locale)).join('\n')
  if (localized !== message) return localized
  // Chinese UI uses the backend original; Chinese originals are unreadable in English UI, so fall back to generic error-code descriptions
  if (locale === 'zh-CN' || !cjk.test(message)) return message
  const code = typeof e?.data?.code === 'string' ? e.data.code : typeof e?.code === 'string' ? e.code : 'unknown'
  const texts = messagesFor(codes, locale) as Record<string, string>
  return texts[code] ?? texts.unknown!
}
