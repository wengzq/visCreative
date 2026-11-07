import type { ProviderType } from '../registry'
import { ARK_ENDPOINTS, createArkProvider } from './index'

export const arkProviderType: ProviderType = {
  type: 'volcengine-ark',
  label: { zh: '火山方舟', en: 'Volcengine Ark' },
  needsKey: true,
  kinds: ['image', 'video', 'audio'],
  regions: [{ id: 'beijing', label: { zh: '北京', en: 'Beijing' }, baseUrl: 'https://ark.cn-beijing.volces.com/api/v3' }],
  allowCustomBaseUrl: true,
  endpoints: ARK_ENDPOINTS,
  knownModels: [],
  help: {
    consoleUrl: 'https://console.volcengine.com/ark',
    key: { zh: '在火山方舟控制台创建 API Key。', en: 'Create an API key in the Volcengine Ark console.' },
    model: { zh: '在火山方舟控制台 › 在线推理 中复制模型 ID 或接入点 ID', en: 'Copy a model ID or endpoint ID from the Volcengine Ark console › Online inference' },
  },
  verified: true,
  create: (config, deps) => createArkProvider({ ...config, ...deps }),
}
