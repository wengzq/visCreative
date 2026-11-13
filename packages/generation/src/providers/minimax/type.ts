import type { ModelDocLink } from '@vis/protocol'
import type { ProviderType } from '../registry'
import { createMiniMaxProvider, MINIMAX_ENDPOINTS, MINIMAX_REGIONS } from './index'
import { MINIMAX_MODELS } from './models'

// RFC 0045: official pages, fetched and checked 2026-11-11. Links only; Agents read the current page.
// The H3 page is an example gallery rather than a writing manual; it is still the vendor's own prompting material.
const minimaxDocs = (kind: string): ModelDocLink[] => kind === 'video'
  ? [{ kind: 'prompt_guide', url: 'https://platform.minimax.io/docs/guides/video-prompt' }, { kind: 'api_reference', url: 'https://platform.minimax.io/docs/api-reference/video-generation-v2-create.md' }]
  : [{ kind: 'api_reference', url: 'https://platform.minimax.io/docs/api-reference/image-generation-t2i.md' }]

export const minimaxProviderType: ProviderType = {
  type: 'minimax',
  label: { zh: 'MiniMax 海螺', en: 'MiniMax Hailuo' },
  needsKey: true,
  kinds: ['video', 'image'],
  regions: MINIMAX_REGIONS,
  allowCustomBaseUrl: true,
  endpoints: MINIMAX_ENDPOINTS,
  knownModels: MINIMAX_MODELS.map(({ id, label, kind }) => ({ id, label, kind, docs: minimaxDocs(kind) })),
  help: {
    consoleUrl: 'https://platform.minimax.io/user-center/basic-information/interface-key',
    key: { zh: '在所选地区的 MiniMax 开放平台创建按量付费 API Key。', en: 'Create a pay-as-you-go API key on the MiniMax platform for the selected region.' },
    model: { zh: '视频使用 MiniMax-H3 系列的 v2 API；图片使用 image-01。', en: 'Use MiniMax-H3 family models through video v2, or image-01 for images.' },
  },
  availability: {
    zh: '选择与账户一致的中国或国际地区。取消仅停止本地等待，服务商可能继续生成并计费。使用自定义地址会将 API 密钥发送到该地址的主机。',
    en: 'Choose the China or international region matching your account. Cancellation stops local waiting; generation and billing may continue. A custom URL sends your API key to that host.',
  },
  verified: true,
  create: (config, deps) => createMiniMaxProvider({ ...config, ...deps }),
}
