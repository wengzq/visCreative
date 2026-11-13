import type { ModelDocLink } from '@vis/protocol'
import type { ProviderType } from '../registry'
import { ARK_ENDPOINTS, createArkProvider } from './index'

// RFC 0045: official pages, fetched and checked 2026-11-11. Links only; Agents read the current page.
const videoApi: ModelDocLink = { kind: 'api_reference', url: 'https://docs.volcengine.com/docs/ark/create-video-generation-task-api?lang=zh' }
const seedance20: ModelDocLink[] = [{ kind: 'prompt_guide', url: 'https://docs.volcengine.com/docs/ark/seedance-2-0-prompt-guide?lang=zh' }, videoApi]
const seedance25: ModelDocLink[] = [{ kind: 'prompt_guide', url: 'https://docs.volcengine.com/docs/ark/seedance-2-5-prompt-guide?lang=zh' }, videoApi]

export const arkProviderType: ProviderType = {
  type: 'volcengine-ark',
  label: { zh: '火山方舟', en: 'Volcengine Ark' },
  needsKey: true,
  kinds: ['image', 'video', 'audio'],
  regions: [{ id: 'beijing', label: { zh: '北京', en: 'Beijing' }, baseUrl: 'https://ark.cn-beijing.volces.com/api/v3' }],
  allowCustomBaseUrl: true,
  endpoints: ARK_ENDPOINTS,
  knownModels: ['doubao-seedance-2-0-260128', 'doubao-seedance-2-0-fast-260128', 'doubao-seedance-2-0-mini-260615', 'doubao-seedance-2-5-260628'].map(id => ({ id, label: id, kind: 'video' as const, docs: id.startsWith('doubao-seedance-2-5') ? seedance25 : seedance20 })),
  // Endpoint IDs hide the model, so the fallback carries only family-wide pages. The Seedream guide covers 4.0, 4.5 and 5.0 lite, not 5.0 pro or flash.
  modelDocs: {
    video: [videoApi],
    image: [{ kind: 'prompt_guide', url: 'https://docs.volcengine.com/docs/ark/seedream-4-0-5-0-prompt-guide?lang=zh' }, { kind: 'api_reference', url: 'https://docs.volcengine.com/docs/ark/image-generation-api?lang=zh' }],
  },
  help: {
    consoleUrl: 'https://console.volcengine.com/ark',
    key: { zh: '在火山方舟控制台创建 API Key。', en: 'Create an API key in the Volcengine Ark console.' },
    model: { zh: '在火山方舟控制台 › 在线推理 中复制模型 ID 或接入点 ID', en: 'Copy a model ID or endpoint ID from the Volcengine Ark console › Online inference' },
  },
  verified: true,
  create: (config, deps) => createArkProvider({ ...config, ...deps }),
}
